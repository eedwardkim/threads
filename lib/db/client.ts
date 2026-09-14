import postgres, { type Sql } from "postgres";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "./schema";

export type Database = PostgresJsDatabase<typeof schema>;

export interface DatabaseOptions {
  /** Maximum simultaneous connections held by this process. Keep it small on serverless. */
  max?: number;
  /** Use prepared statements. Must stay off behind a transaction-mode pooler (Supavisor/PgBouncer). */
  prepare?: boolean;
}

export interface DatabaseHandle {
  sql: Sql;
  db: Database;
  close(): Promise<void>;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "db", "postgres"]);

function readEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

/**
 * TLS is verified against the system trust store, plus DATABASE_CA_CERT (PEM) when the
 * server uses a private CA (Supabase publishes one for direct connections).
 * Certificate validation is never disabled; local loopback databases may opt out with sslmode=disable.
 */
export function tlsOptions(url: string): false | { rejectUnauthorized: true; ca?: string } {
  const parsed = new URL(url);
  const mode = parsed.searchParams.get("sslmode") ?? parsed.searchParams.get("ssl");
  if (mode === "disable") {
    if (!LOCAL_HOSTS.has(parsed.hostname)) throw new Error("sslmode=disable is only allowed for local databases.");
    return false;
  }
  const ca = readEnv("DATABASE_CA_CERT")?.replace(/\\n/g, "\n");
  return ca ? { rejectUnauthorized: true, ca } : { rejectUnauthorized: true };
}

export function databaseUrl(): string {
  const url = readEnv("DATABASE_URL");
  if (!url) {
    throw new Error("DATABASE_URL is not set. Threads requires a Postgres connection (see .env.example); it never falls back to SQLite.");
  }
  return url;
}

export function migrationDatabaseUrl(): string {
  return readEnv("DIRECT_DATABASE_URL") ?? databaseUrl();
}

export function connectDatabase(url: string, options: DatabaseOptions = {}): DatabaseHandle {
  const target = new URL(url);
  target.searchParams.delete("sslmode");
  target.searchParams.delete("ssl");
  const sql = postgres(target.toString(), {
    max: options.max ?? Number(readEnv("DATABASE_POOL_MAX") ?? 4),
    prepare: options.prepare ?? false,
    ssl: tlsOptions(url),
    idle_timeout: 20,
    max_lifetime: 60 * 30,
    connect_timeout: 15,
    connection: { application_name: "threads" },
    onnotice: () => undefined,
    transform: { undefined: null },
  });
  const db = drizzle(sql, { schema });
  return { sql, db, close: () => sql.end({ timeout: 5 }) };
}

const handleGlobal = globalThis as typeof globalThis & { __threadsDatabase?: DatabaseHandle };

/** One small pool per warm process. Never opened at import time. */
export function getDatabase(): DatabaseHandle {
  if (!handleGlobal.__threadsDatabase) handleGlobal.__threadsDatabase = connectDatabase(databaseUrl());
  return handleGlobal.__threadsDatabase;
}

export function setDatabaseForTests(handle: DatabaseHandle | undefined): void {
  handleGlobal.__threadsDatabase = handle;
}
