import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { importSqlite, type ImportReport } from "../../lib/import/sqlite";
import { seedDatabase } from "../../lib/seed";
import { newUser, testDatabase } from "./harness";

// Representative legacy database: the exact SQLite schema the single-user app used, in WAL mode.
const LEGACY_SCHEMA = `
create table folders (id text primary key, name text not null, parent_id text references folders(id) on delete cascade, created_at integer not null, sort_order integer not null default 0);
create table chats (id text primary key, title text not null, folder_id text references folders(id) on delete set null, created_at integer not null);
create table messages (id text primary key, chat_id text not null references chats(id) on delete cascade, thread_id text references threads(id) on delete cascade, role text not null, content text not null, model_key text, complete integer not null default 1, input_tokens integer, output_tokens integer, created_at integer not null);
create table threads (id text primary key, chat_id text not null references chats(id) on delete cascade, parent_message_id text not null references messages(id) on delete cascade, anchor_start integer not null, anchor_end integer not null, anchor_exact text not null, compressed_context text, context_frozen_at integer, source text not null default 'user', resolved integer not null default 0, title text not null, created_at integer not null);
create table app_meta (key text primary key, value text not null);
`;

const ANSWER = "The determinant det(A) = ∏ λᵢ — 行列式 — and $\\int_0^1 x^2\\,dx = \\tfrac13$. 😀 done.";
const QUOTE = "det(A) = ∏ λᵢ";

export interface Fixture {
  path: string;
  ids: { folder: string; sub: string; chat: string; user: string; answer: string; thread: string; reply: string; demoFolder: string; demoChat: string; demoUser: string; demoAnswer: string };
}

function writeFixture(dir: string, name = "threads.sqlite"): Fixture {
  const path = join(dir, name);
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(LEGACY_SCHEMA);
  const ids = {
    folder: randomUUID(), sub: randomUUID(), chat: randomUUID(), user: randomUUID(), answer: randomUUID(), thread: randomUUID(), reply: randomUUID(),
    demoFolder: "demo-folder-linear-algebra", demoChat: "demo-la-span", demoUser: randomUUID(), demoAnswer: randomUUID(),
  };
  const t0 = Date.parse("2026-03-01T10:00:00Z");
  db.prepare("insert into folders values (?, ?, ?, ?, ?)").run(ids.folder, "Research", null, t0, 0);
  db.prepare("insert into folders values (?, ?, ?, ?, ?)").run(ids.sub, "Papers", ids.folder, t0 + 1, 0);
  db.prepare("insert into folders values (?, ?, ?, ?, ?)").run(ids.demoFolder, "Linear Algebra (renamed)", null, t0 + 2, 0);
  db.prepare("insert into chats values (?, ?, ?, ?)").run(ids.chat, "Eigenvalues", ids.sub, t0 + 10);
  db.prepare("insert into chats values (?, ?, ?, ?)").run(ids.demoChat, "01 · Span (my notes)", ids.demoFolder, t0 + 11);
  const message = db.prepare("insert into messages values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  message.run(ids.user, ids.chat, null, "user", "What is det(A)?", null, 1, null, null, t0 + 100);
  message.run(ids.answer, ids.chat, null, "assistant", ANSWER, "thinking", 1, 12, 34, t0 + 101);
  db.prepare("insert into threads values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    ids.thread, ids.chat, ids.answer, ANSWER.indexOf(QUOTE), ANSWER.indexOf(QUOTE) + QUOTE.length, QUOTE,
    JSON.stringify({ kind: "fallback", messages: [{ role: "user", content: "Determinant discussion" }] }), t0 + 150, "user", 1, QUOTE, t0 + 150,
  );
  message.run(ids.reply, ids.chat, ids.thread, "user", "Why the product of eigenvalues?", null, 1, null, null, t0 + 200);
  message.run(randomUUID(), ids.chat, ids.thread, "assistant", "Because A is similar to a triangular matrix… (partial", "fast", 0, null, null, t0 + 201);
  message.run(ids.demoUser, ids.demoChat, null, "user", "Follow-up I typed in the demo", null, 1, null, null, t0 + 300);
  message.run(ids.demoAnswer, ids.demoChat, null, "assistant", "A demo follow-up answer.", "fast", 1, 1, 2, t0 + 301);
  db.prepare("insert into app_meta values ('study-library-v1', '1')").run();
  // Leave data in the WAL (no checkpoint) so the importer must read WAL-resident rows.
  db.pragma("wal_autocheckpoint = 0");
  db.prepare("update chats set title = ? where id = ?").run("Eigenvalues and determinants", ids.chat);
  // Keep the writer open (like a running app) so nothing checkpoints the WAL away before the import reads it.
  keepers.push(db);
  return { path, ids };
}

const keepers: InstanceType<typeof Database>[] = [];
const fileHash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

let dir: string;
let fixture: Fixture;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "threads-import-"));
  fixture = writeFixture(dir);
});
afterAll(() => {
  for (const keeper of keepers) keeper.close();
  rmSync(dir, { recursive: true, force: true });
});

const run = (userId: string, overrides: Partial<Parameters<typeof importSqlite>[0]> = {}): Promise<ImportReport> =>
  importSqlite({ sqlitePath: fixture.path, userId, handle: testDatabase(), dryRun: false, requireAuthUser: false, ...overrides });
const runFresh = async (userId: string, name: string, overrides: Partial<Parameters<typeof importSqlite>[0]> = {}) => {
  const fresh = writeFixture(dir, name);
  return { fresh, report: await importSqlite({ sqlitePath: fresh.path, userId, handle: testDatabase(), dryRun: false, requireAuthUser: false, ...overrides }) };
};

describe("legacy SQLite import", () => {
  it("dry-runs without writing, then imports losslessly into the selected user only", async () => {
    const owner = newUser();
    const bystander = newUser();
    await seedDatabase(owner.repository);
    const before = fileHash(fixture.path);
    const walBefore = statSync(`${fixture.path}-wal`).size;

    const dry = await run(owner.userId, { dryRun: true });
    expect(dry.errors).toEqual([]);
    expect(dry.source).toEqual({ folders: 3, chats: 2, messages: 6, threads: 1 });
    expect(dry.planned).toEqual({ folders: 2, chats: 1, messages: 6, threads: 1 });
    expect(dry.written).toEqual({ folders: 0, chats: 0, messages: 0, threads: 0 });
    expect(await owner.repository.getChat(fixture.ids.chat)).toBeNull();

    const report = await run(owner.userId);
    expect(report.errors).toEqual([]);
    expect(report.written).toEqual({ folders: 2, chats: 1, messages: 6, threads: 1 });
    expect(report.destinationHash).toBe(report.contentHash);
    // Source untouched (same bytes, WAL not checkpointed).
    expect(fileHash(fixture.path)).toBe(before);
    expect(statSync(`${fixture.path}-wal`).size).toBe(walBefore);

    const chat = await owner.repository.getChat(fixture.ids.chat);
    expect(chat).toMatchObject({ id: fixture.ids.chat, title: "Eigenvalues and determinants", folderId: fixture.ids.sub, createdAt: Date.parse("2026-03-01T10:00:00Z") + 10 });
    const main = await owner.repository.listMessages(fixture.ids.chat, null);
    expect(main.map((message) => [message.id, message.content, message.modelKey, message.complete, message.inputTokens])).toEqual([
      [fixture.ids.user, "What is det(A)?", null, true, null],
      [fixture.ids.answer, ANSWER, "thinking", true, 12],
    ]);
    const [thread] = await owner.repository.listThreads(fixture.ids.chat);
    expect(thread).toMatchObject({ id: fixture.ids.thread, parentMessageId: fixture.ids.answer, anchorExact: QUOTE, resolved: true, contextFrozenAt: Date.parse("2026-03-01T10:00:00Z") + 150 });
    expect(ANSWER.slice(thread.anchorStart, thread.anchorEnd)).toBe(QUOTE);
    expect(JSON.parse(thread.compressedContext!)).toMatchObject({ kind: "fallback" });
    const replies = await owner.repository.listMessages(fixture.ids.chat, fixture.ids.thread);
    expect(replies.map((message) => message.complete)).toEqual([true, false]);
    expect(replies[1].content).toContain("(partial");
    const folders = await owner.repository.listFolders();
    expect(folders.find((folder) => folder.id === fixture.ids.sub)).toMatchObject({ parentId: fixture.ids.folder, name: "Papers" });

    // Legacy demo ids land on this user's own demo instances (by catalog key), keeping the custom names.
    const demoChat = (await owner.repository.listChats()).find((candidate) => candidate.demoKey === "demo-la-span")!;
    expect(demoChat.id).not.toBe("demo-la-span");
    expect(demoChat.title).toBe("01 · Span (my notes)");
    expect((await owner.repository.listMessages(demoChat.id, null)).map((message) => message.id)).toEqual([fixture.ids.demoUser, fixture.ids.demoAnswer]);
    expect(folders.find((folder) => folder.demoKey === "demo-folder-linear-algebra")?.name).toBe("Linear Algebra (renamed)");
    expect(report.remapped.map((entry) => [entry.from, entry.reason])).toEqual([["demo-folder-linear-algebra", "demo"], ["demo-la-span", "demo"]]);

    // Nothing leaked to anyone else.
    expect(await bystander.repository.getChat(fixture.ids.chat)).toBeNull();
    expect(await bystander.repository.listChats()).toEqual([]);
  });

  it("is idempotent on rerun and refuses to overwrite changed history", async () => {
    const owner = newUser();
    const { fresh, report: first } = await runFresh(owner.userId, "rerun.sqlite");
    expect(first.errors).toEqual([]);
    expect(first.remapped.filter((entry) => entry.reason === "taken")).toEqual([]);
    const again = await importSqlite({ sqlitePath: fresh.path, userId: owner.userId, handle: testDatabase(), dryRun: false, requireAuthUser: false });
    expect(again.errors).toEqual([]);
    expect(again.written).toEqual({ folders: 0, chats: 0, messages: 0, threads: 0 });
    expect(again.alreadyPresent).toEqual({ folders: 3, chats: 2, messages: 6, threads: 1 });
    expect((await owner.repository.listMessages(fresh.ids.chat, null)).length).toBe(2);
    // Rewriting an already-imported message in the source is a conflict: nothing is overwritten.
    keepers.find((keeper) => keeper.name === fresh.path)!.prepare("update messages set content = ? where id = ?").run("Edited later", fresh.ids.user);
    const conflict = await importSqlite({ sqlitePath: fresh.path, userId: owner.userId, handle: testDatabase(), dryRun: false, requireAuthUser: false });
    expect(conflict.errors).toEqual([expect.stringContaining(`message ${fresh.ids.user} already exists with different content`)]);
    expect((await owner.repository.getMessage(fresh.ids.user))?.content).toBe("What is det(A)?");

    // A source whose completed content differs from what was imported is a conflict, not an overwrite.
    const tampered = writeFixture(dir, "tampered.sqlite");
    const db = new Database(tampered.path);
    db.prepare("update messages set content = ? where id = ?").run("Rewritten history", tampered.ids.answer);
    db.close();
    const other = newUser();
    expect((await importSqlite({ sqlitePath: tampered.path, userId: other.userId, handle: testDatabase(), dryRun: false, requireAuthUser: false })).errors).toEqual([
      expect.stringContaining("anchor does not match parent source"),
    ]);
    expect(await other.repository.getChat(tampered.ids.chat)).toBeNull();
  });

  it("remaps ids already owned by someone else deterministically instead of failing or leaking", async () => {
    const a = newUser();
    const b = newUser();
    expect((await run(a.userId)).errors).toEqual([]);
    const report = await run(b.userId);
    expect(report.errors).toEqual([]);
    expect(report.written).toEqual({ folders: 3, chats: 2, messages: 6, threads: 1 });
    const taken = report.remapped.filter((entry) => entry.reason === "taken");
    expect(taken.map((entry) => entry.from)).toContain(fixture.ids.chat);
    const mappedChat = taken.find((entry) => entry.from === fixture.ids.chat)!.to;
    expect(await b.repository.getChat(mappedChat)).toMatchObject({ title: "Eigenvalues and determinants" });
    expect(await b.repository.getChat(fixture.ids.chat)).toBeNull();
    expect(await a.repository.getChat(mappedChat)).toBeNull();
    const [thread] = await b.repository.listThreads(mappedChat);
    expect(thread.anchorExact).toBe(QUOTE);
    expect((await b.repository.listMessages(mappedChat, thread.id)).length).toBe(2);
    // Rerunning yields the same derived ids and writes nothing.
    const again = await run(b.userId);
    expect(again.written.messages).toBe(0);
    expect(again.remapped.find((entry) => entry.from === fixture.ids.chat)?.to).toBe(mappedChat);
  });

  it("refuses to merge into a demo chat the user already hydrated unless told to skip it", async () => {
    const owner = newUser();
    await seedDatabase(owner.repository);
    const demoChat = (await owner.repository.listChats()).find((candidate) => candidate.demoKey === "demo-la-span")!;
    await owner.repository.appendMessage({ chatId: demoChat.id, threadId: null, role: "user", content: "Hydrated already", modelKey: null, complete: true });
    const refused = await run(owner.userId);
    expect(refused.errors).toEqual([expect.stringContaining("already hydrated")]);
    expect(await owner.repository.getChat(fixture.ids.chat)).toBeNull();
    const skipped = await run(owner.userId, { skipHydratedDemos: true });
    expect(skipped.errors).toEqual([]);
    expect(skipped.skippedDemoChats).toEqual(["demo-la-span"]);
    expect(skipped.written).toEqual({ folders: 2, chats: 1, messages: 4, threads: 1 });
    expect((await owner.repository.listMessages(demoChat.id, null)).map((message) => message.content)).toEqual(["Hydrated already"]);
  });

  it("rejects an invalid destination user and a missing source", async () => {
    await expect(run("not-a-user")).rejects.toThrow(/UUID/);
    await expect(run(randomUUID(), { sqlitePath: join(dir, "missing.sqlite") })).rejects.toThrow(/not found/);
    await expect(run(randomUUID(), { requireAuthUser: true })).rejects.toThrow(/auth\.users/);
  });
});
