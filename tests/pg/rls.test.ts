import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { connectDatabase } from "../../lib/db/client";
import { chats, folders, generationJobs, messages, threads } from "../../lib/db/schema";
import { withUser } from "../../lib/db/session";
import { newUser, testDatabase, TEST_DATABASE_URL } from "./harness";

type Row = Record<string, unknown>;
const rows = (result: unknown) => result as Row[];

describe("row level security under the runtime role", () => {
  it("runs as a non-login, non-bypassing role and hides other owners' rows from every table", async () => {
    const a = newUser();
    const b = newUser();
    const chatA = await a.repository.createChat();
    const chatB = await b.repository.createChat();
    const message = await a.repository.appendMessage({ chatId: chatA.id, threadId: null, role: "assistant", content: "Only A may read this", modelKey: "fast", complete: true });
    await a.repository.insertThread({ parentMessageId: message.id, anchorStart: 0, anchorEnd: 4, source: "user", compressedContext: null, contextFrozenAt: null });
    await a.repository.createFolder("A's folder");

    await withUser(testDatabase(), b.userId, async (tx) => {
      const [role] = rows(await tx.execute(sql`select current_user as name, rolbypassrls as bypass, rolcanlogin as login, rolinherit as inherit from pg_roles where rolname = current_user`));
      expect(role).toMatchObject({ name: "threads_app", bypass: false, login: false, inherit: false });
      for (const table of [folders, chats, messages, threads, generationJobs]) {
        const owners = await tx.select({ ownerId: table.ownerId }).from(table);
        expect(owners.every((row) => row.ownerId === b.userId), `${String(table)} leaked rows`).toBe(true);
      }
      expect(await tx.select().from(chats).where(eq(chats.id, chatA.id))).toEqual([]);
      expect((await tx.select().from(chats).where(eq(chats.id, chatB.id))).length).toBe(1);
      expect(await tx.select().from(messages).where(eq(messages.id, message.id))).toEqual([]);
    });
  });

  it("blocks writes for other owners and forged owner ids through policy WITH CHECK, even with valid ids", async () => {
    const a = newUser();
    const b = newUser();
    const chatA = await a.repository.createChat();
    const message = await a.repository.appendMessage({ chatId: chatA.id, threadId: null, role: "assistant", content: "Partial", modelKey: "fast", complete: false });
    const folderB = await b.repository.createFolder("B");
    await withUser(testDatabase(), b.userId, async (tx) => {
      // Update/delete of A's rows silently affect nothing (USING excludes them).
      expect(await tx.update(chats).set({ title: "Hijacked" }).where(eq(chats.id, chatA.id)).returning()).toEqual([]);
      expect(await tx.update(messages).set({ content: "Hijacked" }).where(eq(messages.id, message.id)).returning()).toEqual([]);
      expect(await tx.update(chats).set({ folderId: folderB.id }).where(eq(chats.id, chatA.id)).returning()).toEqual([]);
      expect(await tx.delete(chats).where(eq(chats.id, chatA.id)).returning()).toEqual([]);
    });
    // Inserting with a forged owner id fails the WITH CHECK clause (42501 insufficient_privilege).
    await expect(withUser(testDatabase(), b.userId, (tx) => tx.insert(chats).values({ id: randomUUID(), ownerId: a.userId, title: "Forged", folderId: null, createdAt: 1, demoKey: null })))
      .rejects.toMatchObject({ cause: expect.objectContaining({ code: "42501" }) });
    // Inserting into A's chat as B fails the owner-aware foreign key.
    await expect(withUser(testDatabase(), b.userId, (tx) => tx.insert(messages).values({ id: randomUUID(), ownerId: b.userId, chatId: chatA.id, threadId: null, role: "user", content: "Cross-owner", modelKey: null, complete: true, attempt: 0, createdAt: 1 })))
      .rejects.toMatchObject({ cause: expect.objectContaining({ code: "23503" }) });
    expect(await a.repository.getChat(chatA.id)).toMatchObject({ title: chatA.title });
    expect(await a.repository.getMessage(message.id)).toMatchObject({ content: "Partial" });
    expect(await a.repository.listChats()).toHaveLength(1);
  });

  it("cannot stop, attach to, or finish another owner's generation job", async () => {
    const a = newUser();
    const b = newUser();
    const chatA = await a.repository.createChat();
    const admitted = await a.jobs.admit({ requestId: randomUUID(), kind: "generation", chatId: chatA.id, threadId: null, payloadHash: "x", leaseMs: 30_000 });
    if (!admitted.admitted) throw new Error("expected admission");
    try {
      expect(await b.jobs.requestStop(admitted.job.id)).toBe(false);
      expect(await b.jobs.requestStopScope(chatA.id)).toBe(0);
      expect(await b.jobs.get(admitted.job.id)).toBeNull();
      expect(await b.jobs.finish(admitted.job.id, admitted.job.fence, "stopped")).toBe(false);
      expect(await b.jobs.attach(admitted.job.id, admitted.job.fence, { messageId: null, userMessageId: null, attempt: 0 })).toBe(false);
      await withUser(testDatabase(), b.userId, async (tx) => {
        expect(await tx.update(generationJobs).set({ cancelRequested: true }).where(eq(generationJobs.id, admitted.job.id)).returning()).toEqual([]);
      });
      expect(await a.jobs.get(admitted.job.id)).toMatchObject({ status: "running", cancelRequested: false });
    } finally {
      expect(await a.jobs.finish(admitted.job.id, admitted.job.fence, "stopped")).toBe(true);
    }
  });

  it("keeps the threads schema out of the public Data API roles", async () => {
    const db = testDatabase().db;
    const [privileges] = rows(await db.execute(sql`
      select
        exists(select 1 from pg_roles where rolname = 'anon') as has_anon,
        coalesce((select has_schema_privilege('anon', 'threads', 'USAGE') where exists(select 1 from pg_roles where rolname = 'anon')), false) as anon_usage,
        coalesce((select has_schema_privilege('authenticated', 'threads', 'USAGE') where exists(select 1 from pg_roles where rolname = 'authenticated')), false) as authenticated_usage,
        coalesce((select has_table_privilege('authenticated', 'threads.generation_jobs', 'INSERT') where exists(select 1 from pg_roles where rolname = 'authenticated')), false) as authenticated_jobs_insert,
        coalesce((select has_table_privilege('anon', 'threads.messages', 'SELECT') where exists(select 1 from pg_roles where rolname = 'anon')), false) as anon_messages_select
    `));
    expect(privileges).toMatchObject({ anon_usage: false, authenticated_usage: false, authenticated_jobs_insert: false, anon_messages_select: false });
    const tables = rows(await db.execute(sql`select tablename, rowsecurity from pg_tables where schemaname = 'threads' and tablename <> 'schema_migrations'`));
    expect(tables.length).toBeGreaterThanOrEqual(7);
    expect(tables.every((table) => table.rowsecurity === true)).toBe(true);
  });
});

describe("pooled identity reset", () => {
  const single = connectDatabase(TEST_DATABASE_URL!, { max: 1, prepare: false });
  afterAll(() => single.close());

  const identity = async () => rows(await single.db.execute(sql`select current_user as role, current_setting('request.jwt.claims', true) as claims`))[0];

  it("drops role and claims on the same physical connection after COMMIT", async () => {
    const user = newUser();
    await withUser(single, user.userId, async (tx) => {
      const [inside] = rows(await tx.execute(sql`select current_user as role, threads.current_user_id() as uid`));
      expect(inside).toEqual({ role: "threads_app", uid: user.userId });
    });
    const after = await identity();
    expect(after.role).not.toBe("threads_app");
    expect(after.claims ?? "").toBe("");
  });

  it("drops role and claims on the same physical connection after ROLLBACK", async () => {
    const user = newUser();
    await expect(withUser(single, user.userId, async (tx) => {
      await tx.execute(sql`select threads.current_user_id()`);
      throw new Error("force rollback");
    })).rejects.toThrow("force rollback");
    const after = await identity();
    expect(after.role).not.toBe("threads_app");
    expect(after.claims ?? "").toBe("");
  });

  it("never lets a later user on the same connection see the earlier user's data", async () => {
    const a = newUser(single);
    const b = newUser(single);
    const chatA = await a.repository.createChat();
    await b.repository.createChat();
    expect(await b.repository.getChat(chatA.id)).toBeNull();
    expect((await b.repository.listChats()).map((chat) => chat.id)).not.toContain(chatA.id);
    await withUser(single, b.userId, async (tx) => {
      expect(rows(await tx.execute(sql`select threads.current_user_id() as uid`))[0].uid).toBe(b.userId);
    });
    expect(await a.repository.getChat(chatA.id)).not.toBeNull();
  });

  it("refuses to run work without a verified user id", async () => {
    await expect(withUser(single, "", async () => undefined)).rejects.toThrow(/verified user id/);
    await expect(withUser(single, "not-a-uuid", async () => undefined)).rejects.toThrow(/verified user id/);
    await withUser(single, newUser().userId, async (tx) => {
      // Setting claims to a non-JSON or sub-less value must not yield a usable identity.
      await tx.execute(sql`select set_config('request.jwt.claims', '{}', true)`);
      const [{ uid }] = rows(await tx.execute(sql`select threads.current_user_id() as uid`));
      expect(uid).toBeNull();
      expect(await tx.select().from(chats)).toEqual([]);
    });
  });
});
