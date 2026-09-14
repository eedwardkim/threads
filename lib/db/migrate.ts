import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Sql } from "postgres";

export const MIGRATIONS_DIR = path.join(process.cwd(), "db", "migrations");

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

async function listMigrations(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter((name) => /^\d{4}_[\w-]+\.sql$/.test(name)).sort();
}

/**
 * Applies versioned SQL files exactly once each, in lexical order, inside one transaction per file.
 * Runs only when invoked explicitly (npm run db:migrate) — never at import, cold start, or build.
 */
export async function runMigrations(sql: Sql, dir = MIGRATIONS_DIR): Promise<MigrationResult> {
  const files = await listMigrations(dir);
  const result: MigrationResult = { applied: [], skipped: [] };
  await sql`create schema if not exists threads`;
  await sql`create table if not exists threads.schema_migrations (version text primary key, applied_at timestamptz not null default now())`;
  for (const file of files) {
    const version = file.replace(/\.sql$/, "");
    const body = await readFile(path.join(dir, file), "utf8");
    await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext('threads.schema_migrations'))`;
      const [existing] = await tx`select version from threads.schema_migrations where version = ${version}`;
      if (existing) {
        result.skipped.push(version);
        return;
      }
      await tx.unsafe(body);
      await tx`insert into threads.schema_migrations (version) values (${version})`;
      result.applied.push(version);
    });
  }
  return result;
}

export async function pendingMigrations(sql: Sql, dir = MIGRATIONS_DIR): Promise<string[]> {
  const files = await listMigrations(dir);
  const [table] = await sql`select 1 from information_schema.tables where table_schema = 'threads' and table_name = 'schema_migrations'`;
  if (!table) return files.map((file) => file.replace(/\.sql$/, ""));
  const applied = new Set((await sql`select version from threads.schema_migrations`).map((row) => row.version as string));
  return files.map((file) => file.replace(/\.sql$/, "")).filter((version) => !applied.has(version));
}
