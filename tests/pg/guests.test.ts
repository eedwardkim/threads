import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { POST as createChat } from "../../app/api/chats/route";
import { dataFor } from "../../lib/db/access";
import { setDatabaseForTests } from "../../lib/db/client";
import { withUser } from "../../lib/db/session";
import { endGuest, registerGuest } from "../../lib/auth/guest";
import { setAuthResolverForTests } from "../../lib/auth/server";
import { testDatabase } from "./harness";

const authIds: string[] = [];

async function authUser(anonymous = true, ageMinutes = 0) {
  const id = randomUUID();
  authIds.push(id);
  await testDatabase().db.execute(sql`insert into auth.users (id, is_anonymous, created_at, updated_at)
    values (${id}::uuid, ${anonymous}, now() - (${ageMinutes} * interval '1 minute'), now())`);
  return { userId: id, ...dataFor(id, testDatabase(), anonymous) };
}

async function expire(id: string) {
  await testDatabase().db.execute(sql`update threads.guest_sessions set expires_at = now() - interval '1 second' where owner_id = ${id}::uuid`);
}

async function enroll(id: string) {
  const rows = await testDatabase().db.execute<{ created: string }>(sql`select created_at::text as created from auth.users where id = ${id}::uuid`);
  return registerGuest(id, rows[0].created);
}

async function purge(id: string) {
  return testDatabase().db.execute<{ removed: boolean }>(sql`select threads.purge_guest(${id}::uuid) as removed`);
}

describe("temporary guests", () => {
  beforeAll(() => setDatabaseForTests(testDatabase()));
  afterEach(() => setAuthResolverForTests(undefined));
  afterAll(async () => {
    setDatabaseForTests(undefined);
    for (const id of authIds) {
      await testDatabase().db.execute(sql`delete from threads.chats where owner_id = ${id}::uuid`);
      await testDatabase().db.execute(sql`delete from threads.folders where owner_id = ${id}::uuid`);
      await testDatabase().db.execute(sql`delete from threads.guest_sessions where owner_id = ${id}::uuid`);
      await testDatabase().db.execute(sql`delete from auth.users where id = ${id}::uuid`);
    }
  });

  it("uses verified auth creation time for an immutable one-hour limit and refuses expired enrollment", async () => {
    const guest = await authUser(true, 10);
    const expiry = await enroll(guest.userId);
    expect(expiry).toBeGreaterThan(Date.now() + 49 * 60_000);
    expect(expiry).toBeLessThanOrEqual(Date.now() + 50 * 60_000);
    expect(await enroll(guest.userId)).toBe(expiry);
    expect(await enroll((await authUser(true, 61)).userId)).toBeNull();
  });

  it("denies reads and writes at expiry, including an already-created repository or API identity", async () => {
    const guest = await authUser();
    await enroll(guest.userId);
    const chat = await guest.repository.createChat();
    await expire(guest.userId);
    await expect(guest.repository.getChat(chat.id)).rejects.toMatchObject({ code: "guest_expired", status: 401 });
    await expect(guest.repository.createChat()).rejects.toMatchObject({ code: "guest_expired" });
    await expect(guest.jobs.admit({ requestId: randomUUID(), kind: "generation", chatId: chat.id, threadId: null, payloadHash: "x", leaseMs: 30_000 }))
      .rejects.toMatchObject({ code: "guest_expired" });
    setAuthResolverForTests(async () => ({ id: guest.userId, email: null, isGuest: true }));
    expect((await createChat(new Request("http://localhost:3000/api/chats", { method: "POST" }))).status).toBe(401);
  });

  it("deletes all application data on explicit end and lets Auth deletion remove the expiry tombstone", async () => {
    const guest = await authUser();
    await enroll(guest.userId);
    const folder = await guest.repository.createFolder("Guest work");
    const chat = await guest.repository.moveChat((await guest.repository.createChat()).id, folder.id);
    const parent = await guest.repository.appendMessage({ chatId: chat.id, threadId: null, role: "assistant", content: "Temporary answer.", complete: true, modelKey: "fast" });
    await guest.repository.insertThread({ parentMessageId: parent.id, anchorStart: 0, anchorEnd: 9, source: "user", compressedContext: null, contextFrozenAt: null });
    await guest.jobs.admit({ requestId: randomUUID(), kind: "generation", chatId: chat.id, threadId: null, payloadHash: "x", leaseMs: 30_000 });
    await guest.jobs.recordUsage(10, 20);
    await testDatabase().db.execute(sql`insert into threads.user_state (owner_id, created_at) values (${guest.userId}::uuid, 1)`);
    await endGuest(guest.userId);
    const tables = ["chats", "messages", "threads", "generation_jobs", "folders", "rate_windows", "usage_ledger", "user_state"];
    for (const table of tables) {
      const rows = await testDatabase().db.execute(sql`select owner_id from ${sql.identifier("threads")}.${sql.identifier(table)} where owner_id = ${guest.userId}::uuid`);
      expect(rows, table).toHaveLength(0);
    }
    await expect(guest.repository.createChat()).rejects.toMatchObject({ code: "guest_expired" });
    const expiry = await enroll(guest.userId);
    expect(expiry).toBeLessThanOrEqual(Date.now());
    await endGuest(guest.userId);
    await testDatabase().db.execute(sql`delete from auth.users where id = ${guest.userId}::uuid and is_anonymous`);
    expect(await testDatabase().db.execute(sql`select owner_id from threads.guest_sessions where owner_id = ${guest.userId}::uuid`)).toHaveLength(0);
  });

  it("only purges expired guests and preserves active guests and permanent accounts, including linked accounts", async () => {
    const old = await authUser();
    const active = await authUser();
    const linked = await authUser();
    const permanent = await authUser(false);
    for (const user of [old, active, linked]) await enroll(user.userId);
    const oldChat = await old.repository.createChat();
    const activeChat = await active.repository.createChat();
    const linkedChat = await linked.repository.createChat();
    const permanentChat = await permanent.repository.createChat();
    await expire(old.userId);
    await expire(linked.userId);
    await testDatabase().db.execute(sql`update auth.users set is_anonymous = false where id = ${linked.userId}::uuid`);
    expect((await purge(old.userId))[0].removed).toBe(true);
    expect((await purge(active.userId))[0].removed).toBe(false);
    expect((await purge(linked.userId))[0].removed).toBe(false);
    expect((await purge(permanent.userId))[0].removed).toBe(false);
    expect(await dataFor(old.userId, testDatabase()).repository.getChat(oldChat.id)).toBeNull();
    expect(await active.repository.getChat(activeChat.id)).not.toBeNull();
    expect(await dataFor(linked.userId, testDatabase()).repository.getChat(linkedChat.id)).not.toBeNull();
    expect(await permanent.repository.getChat(permanentChat.id)).not.toBeNull();
    expect(await testDatabase().db.execute(sql`select id from auth.users where id = ${linked.userId}::uuid`)).toHaveLength(1);
    expect(await enroll(linked.userId)).toBeNull();
  });

  it("keeps enrollment owner-scoped, prevents extending expiry and denies runtime use of bulk cleanup", async () => {
    const a = await authUser();
    const b = await authUser();
    await enroll(a.userId);
    await enroll(b.userId);
    await withUser(testDatabase(), b.userId, async (tx) => {
      expect(await tx.execute(sql`select owner_id from threads.guest_sessions where owner_id = ${a.userId}::uuid`)).toHaveLength(0);
    });
    await expect(withUser(testDatabase(), a.userId, (tx) => tx.execute(sql`update threads.guest_sessions set expires_at = now() + interval '2 hours'`)))
      .rejects.toMatchObject({ cause: expect.objectContaining({ code: "42501" }) });
    await expect(withUser(testDatabase(), a.userId, (tx) => tx.execute(sql`select threads.cleanup_guests()`)))
      .rejects.toMatchObject({ cause: expect.objectContaining({ code: "42501" }) });
    await expect(withUser(testDatabase(), a.userId, (tx) => tx.execute(sql`select threads.purge_guest(${b.userId}::uuid)`)))
      .rejects.toMatchObject({ cause: expect.objectContaining({ code: "42501" }) });
    await endGuest(a.userId);
    expect(await b.repository.createChat()).toBeTruthy();
  });

  it("configures browser-independent cleanup under a non-login role that cannot bypass RLS", async () => {
    const roles = await testDatabase().db.execute(sql`select rolcanlogin, rolbypassrls, rolinherit from pg_roles where rolname = 'threads_guest_manager'`);
    expect(roles[0]).toMatchObject({ rolcanlogin: false, rolbypassrls: false, rolinherit: false });
    const jobs = await testDatabase().db.execute(sql`select schedule, command, active from cron.job where jobname = 'threads-expire-guests'`);
    expect(jobs[0]).toMatchObject({ schedule: "* * * * *", active: true });
    expect(jobs[0].command).toContain("delete from auth.users where is_anonymous");
  });
});
