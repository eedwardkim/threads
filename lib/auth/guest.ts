import { sql } from "drizzle-orm";
import { getDatabase } from "../db/client";
import { withUser } from "../db/session";

export async function registerGuest(userId: string, authCreatedAt: string): Promise<number | null> {
  return withUser(getDatabase(), userId, async (tx) => {
    const rows = await tx.execute<{ expiry: string | null }>(sql`select threads.register_guest(${authCreatedAt}::timestamptz)::text as expiry`);
    return rows[0]?.expiry ? Date.parse(rows[0].expiry) : null;
  });
}

export async function endGuest(userId: string): Promise<void> {
  await withUser(getDatabase(), userId, async (tx) => {
    await tx.execute(sql`select threads.end_guest()`);
  });
}
