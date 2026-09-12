import { afterEach, describe, expect, it } from "vitest";
import { ChatRepository } from "../lib/db/repository";
import { seedDatabase, SEED_ANSWER } from "../lib/seed";

const repositories: ChatRepository[] = [];
function fresh() {
  const repository = new ChatRepository(":memory:");
  repositories.push(repository);
  return repository;
}

afterEach(() => repositories.splice(0).forEach((repository) => repository.close()));

describe("one-time setup", () => {
  it("seeds six complete main messages with all required markdown structures", () => {
    const repository = fresh();
    repository.seedOnce(seedDatabase);
    const [chat] = repository.listChats();
    const messages = repository.listMessages(chat.id);
    expect(messages).toHaveLength(6);
    expect(messages.every((message) => message.complete && message.threadId === null)).toBe(true);
    expect(messages.at(-1)?.content).toBe(SEED_ANSWER);
    expect(SEED_ANSWER).toMatch(/\*\*local-first architecture\*\*/);
    expect(SEED_ANSWER).toContain("```typescript");
    expect(SEED_ANSWER).toContain("https://www.sqlite.org/wal.html");
  });

  it("does not recreate a deleted seed chat", () => {
    const repository = fresh();
    repository.seedOnce(seedDatabase);
    repository.deleteChat(repository.listChats()[0].id);
    repository.seedOnce(seedDatabase);
    expect(repository.listChats()).toEqual([]);
  });

  it("rolls back interrupted seeding and allows a clean retry", () => {
    const repository = fresh();
    expect(() => repository.seedOnce((db) => { db.createChat(); throw new Error("Interrupted"); })).toThrow("Interrupted");
    expect(repository.listChats()).toEqual([]);
    repository.seedOnce(seedDatabase);
    expect(repository.listChats()).toHaveLength(1);
  });
});
