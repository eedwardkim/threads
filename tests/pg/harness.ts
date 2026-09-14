import { randomUUID } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll } from "vitest";
import { connectDatabase, type DatabaseHandle } from "../../lib/db/client";
import { dataFor, type UserData } from "../../lib/db/access";

// Postgres integration tests run against the database named by TEST_DATABASE_URL (or DATABASE_URL from
// .env.local). Every test uses fresh random owners, so no truncation or reset of shared data is ever needed.
function loadDotEnvLocal(): void {
  const file = resolve(process.cwd(), ".env.local");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2];
  }
}

loadDotEnvLocal();

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
export const TEST_DIRECT_DATABASE_URL = process.env.TEST_DIRECT_DATABASE_URL ?? process.env.DIRECT_DATABASE_URL ?? TEST_DATABASE_URL;

if (!TEST_DATABASE_URL) {
  throw new Error("Postgres integration tests need TEST_DATABASE_URL or DATABASE_URL (see README: local Supabase).");
}

let shared: DatabaseHandle | null = null;

/** A bounded pool shared by one test file; closed when the file finishes. */
export function testDatabase(): DatabaseHandle {
  if (!shared) shared = connectDatabase(TEST_DATABASE_URL!, { max: 8, prepare: false });
  return shared;
}

/** A second, independent pool: simulates another server instance. */
export function separateInstance(): DatabaseHandle {
  const handle = connectDatabase(TEST_DATABASE_URL!, { max: 2, prepare: false });
  afterAll(() => handle.close());
  return handle;
}

export function newUser(handle: DatabaseHandle = testDatabase()): UserData & { userId: string } {
  const userId = randomUUID();
  return { userId, ...dataFor(userId, handle) };
}

afterAll(async () => {
  await shared?.close();
  shared = null;
});
