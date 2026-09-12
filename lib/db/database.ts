import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema";

export const SCHEMA_VERSION = 4;
export const DEFAULT_DATABASE_PATH = resolve(process.cwd(), ".data", "threads.sqlite");
export type AppDatabase = BetterSQLite3Database<typeof schema>;

const initialMigration = `
  CREATE TABLE IF NOT EXISTS folders (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    parent_id TEXT REFERENCES folders(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT folders_name_nonempty CHECK (length(name) > 0)
  );
  CREATE TABLE IF NOT EXISTS chats (
    id TEXT PRIMARY KEY NOT NULL,
    title TEXT NOT NULL,
    folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY NOT NULL,
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    thread_id TEXT REFERENCES threads(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    model_key TEXT,
    complete INTEGER NOT NULL DEFAULT 1,
    input_tokens INTEGER,
    output_tokens INTEGER,
    created_at INTEGER NOT NULL,
    CONSTRAINT messages_role_check CHECK (role IN ('user', 'assistant')),
    CONSTRAINT messages_model_key_check CHECK (model_key IS NULL OR model_key IN ('fast', 'thinking', 'opus', 'sonnet', 'haiku', 'gpt-5', 'gpt-5-mini')),
    CONSTRAINT messages_complete_check CHECK (complete IN (0, 1)),
    CONSTRAINT messages_input_tokens_check CHECK (input_tokens IS NULL OR (typeof(input_tokens) = 'integer' AND input_tokens >= 0)),
    CONSTRAINT messages_output_tokens_check CHECK (output_tokens IS NULL OR (typeof(output_tokens) = 'integer' AND output_tokens >= 0))
  );
  CREATE TABLE IF NOT EXISTS threads (
    id TEXT PRIMARY KEY NOT NULL,
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    parent_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    anchor_start INTEGER NOT NULL,
    anchor_end INTEGER NOT NULL,
    anchor_exact TEXT NOT NULL,
    compressed_context TEXT,
    context_frozen_at INTEGER,
    source TEXT NOT NULL DEFAULT 'user',
    resolved INTEGER NOT NULL DEFAULT 0,
    title TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    CONSTRAINT threads_anchor_bounds_check CHECK (typeof(anchor_start) = 'integer' AND typeof(anchor_end) = 'integer' AND anchor_start >= 0 AND anchor_end > anchor_start),
    CONSTRAINT threads_source_check CHECK (source = 'user'),
    CONSTRAINT threads_resolved_check CHECK (resolved IN (0, 1)),
    CONSTRAINT threads_compressed_context_check CHECK (compressed_context IS NULL OR json_valid(compressed_context))
  );
  CREATE INDEX IF NOT EXISTS folders_parent_sort_idx ON folders(parent_id, sort_order);
  CREATE INDEX IF NOT EXISTS chats_created_at_idx ON chats(created_at);
  CREATE INDEX IF NOT EXISTS chats_folder_id_idx ON chats(folder_id);
  CREATE INDEX IF NOT EXISTS messages_scope_created_at_idx ON messages(chat_id, thread_id, created_at);
  CREATE INDEX IF NOT EXISTS messages_thread_id_idx ON messages(thread_id);
  CREATE INDEX IF NOT EXISTS messages_created_at_idx ON messages(created_at);
  CREATE INDEX IF NOT EXISTS threads_chat_created_at_idx ON threads(chat_id, created_at);
  CREATE INDEX IF NOT EXISTS threads_parent_anchor_idx ON threads(parent_message_id, anchor_start, anchor_end);
  CREATE INDEX IF NOT EXISTS threads_created_at_idx ON threads(created_at);
`;

const v4Migration = `
  CREATE TABLE IF NOT EXISTS folders (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    parent_id TEXT REFERENCES folders(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT folders_name_nonempty CHECK (length(name) > 0)
  );
  CREATE INDEX IF NOT EXISTS folders_parent_sort_idx ON folders(parent_id, sort_order);
  ALTER TABLE chats ADD COLUMN folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL;
  CREATE INDEX IF NOT EXISTS chats_folder_id_idx ON chats(folder_id);
`;

const v3Migration = `
  CREATE TABLE messages_new (
    id TEXT PRIMARY KEY NOT NULL,
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    thread_id TEXT REFERENCES threads(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    model_key TEXT,
    complete INTEGER NOT NULL DEFAULT 1,
    input_tokens INTEGER,
    output_tokens INTEGER,
    created_at INTEGER NOT NULL,
    CONSTRAINT messages_role_check CHECK (role IN ('user', 'assistant')),
    CONSTRAINT messages_model_key_check CHECK (model_key IS NULL OR model_key IN ('fast', 'thinking', 'opus', 'sonnet', 'haiku', 'gpt-5', 'gpt-5-mini')),
    CONSTRAINT messages_complete_check CHECK (complete IN (0, 1)),
    CONSTRAINT messages_input_tokens_check CHECK (input_tokens IS NULL OR (typeof(input_tokens) = 'integer' AND input_tokens >= 0)),
    CONSTRAINT messages_output_tokens_check CHECK (output_tokens IS NULL OR (typeof(output_tokens) = 'integer' AND output_tokens >= 0))
  );
  INSERT INTO messages_new SELECT * FROM messages;
  DROP TABLE messages;
  ALTER TABLE messages_new RENAME TO messages;
  CREATE INDEX IF NOT EXISTS messages_scope_created_at_idx ON messages(chat_id, thread_id, created_at);
  CREATE INDEX IF NOT EXISTS messages_thread_id_idx ON messages(thread_id);
  CREATE INDEX IF NOT EXISTS messages_created_at_idx ON messages(created_at);
`;

export function openDatabase(filename: string = DEFAULT_DATABASE_PATH): { db: AppDatabase; sqlite: BetterSqlite3.Database } {
  if (typeof filename !== "string" || filename.length === 0) {
    throw new Error("A SQLite database filename is required.");
  }

  const inMemory = filename === ":memory:";
  const path = inMemory ? filename : resolve(filename);
  if (!inMemory && !existsSync(dirname(path))) {
    mkdirSync(dirname(path), { recursive: true });
  }

  const sqlite = new BetterSqlite3(path, { timeout: 5_000 });
  try {
    sqlite.pragma("foreign_keys = ON");
    if (!inMemory) sqlite.pragma("journal_mode = WAL");
    const currentVersion = Number(sqlite.pragma("user_version", { simple: true }));
    if (currentVersion > SCHEMA_VERSION) {
      throw new Error("This database was created by a newer version of the app.");
    }
    const needsRebuild = currentVersion >= 1 && currentVersion < 3;
    if (needsRebuild) sqlite.pragma("foreign_keys = OFF");
    sqlite.transaction(() => {
      const version = Number(sqlite.pragma("user_version", { simple: true }));
      if (version < 1) sqlite.exec(initialMigration);
      if (version < 2) sqlite.exec("CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
      if (version >= 1 && version < 3) sqlite.exec(v3Migration);
      if (version >= 1 && version < 4) sqlite.exec(v4Migration);
      sqlite.pragma(`user_version = ${SCHEMA_VERSION}`);
    }).immediate();
    if (needsRebuild) sqlite.pragma("foreign_keys = ON");
    return { db: drizzle(sqlite, { schema }), sqlite };
  } catch (error) {
    sqlite.close();
    throw error;
  }
}
