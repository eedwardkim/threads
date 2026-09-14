import { sql } from "drizzle-orm";
import type { PgTransaction } from "drizzle-orm/pg-core";
import type { PostgresJsQueryResultHKT } from "drizzle-orm/postgres-js";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import type { DatabaseHandle } from "./client";
import type * as schema from "./schema";
import { AppError } from "../errors";

export type Tx = PgTransaction<PostgresJsQueryResultHKT, typeof schema, ExtractTablesWithRelations<typeof schema>>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function assertUserId(userId: string): string {
  if (typeof userId !== "string" || !UUID.test(userId)) throw new Error("A verified user id is required.");
  return userId;
}

/**
 * Every unit of work runs in one short transaction as the non-bypassing `threads_app` role with the
 * verified user id in a transaction-local setting. Both revert automatically at COMMIT or ROLLBACK,
 * so a pooled connection never carries identity into the next transaction.
 */
export async function withUser<T>(handle: DatabaseHandle, userId: string, fn: (tx: Tx) => Promise<T>, guest = false): Promise<T> {
  const claims = JSON.stringify({ sub: assertUserId(userId), role: "threads_app" });
  return handle.db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('role', 'threads_app', true), set_config('request.jwt.claims', ${claims}, true)`);
    if (guest) {
      await tx.execute(sql`select pg_advisory_xact_lock_shared(hashtextextended(${"guest:" + userId}, 0))`);
      const rows = await tx.execute<{ active: boolean }>(sql`select not permanent and expires_at > clock_timestamp() as active
        from threads.guest_sessions where owner_id = ${userId}::uuid`);
      if (!rows[0]?.active) throw new AppError("Your guest session has ended. Start a new session or sign in.", 401, "guest_expired");
    }
    return fn(tx);
  });
}
