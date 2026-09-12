import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChatRepository } from "../lib/db/repository";
import { createThread, getThreadData } from "../lib/thread-service";
import { assertIdle } from "../lib/generation-lock";
import type { Message } from "../lib/types";

let repository: ChatRepository;
let parent: Message;
beforeEach(() => {
  repository = new ChatRepository(":memory:");
  const chat = repository.createChat();
  repository.appendMessage({ chatId: chat.id, threadId: null, role: "user", content: "Explain the boundaries.", modelKey: "fast" });
  parent = repository.appendMessage({ chatId: chat.id, threadId: null, role: "assistant", content: "A **durable boundary** makes recovery predictable.\n\nKeep the read path local.", modelKey: "fast" });
});
afterEach(() => repository.close());

function create() {
  return createThread({ parentMessageId: parent.id, anchorStart: 2, anchorEnd: 22, source: "user" }, { repository });
}

describe("single thread-creation entry point", () => {
  it("freezes a briefing and opens an anchored thread without sending any message", async () => {
    const thread = await create();
    const data = getThreadData(thread.id, repository);
    expect(thread.anchorExact).toBe(parent.content.slice(2, 22));
    expect(thread.source).toBe("user");
    expect(thread.contextFrozenAt).toBe(parent.createdAt);
    expect(thread.compressedContext).not.toBeNull();
    expect(data.messages).toEqual([]);
    expect(repository.listMessages(parent.chatId)).toHaveLength(2);
    expect(() => assertIdle()).not.toThrow();
  });

  it("rejects overlaps and releases the generation lock after a failure", async () => {
    await create();
    await expect(create()).rejects.toMatchObject({ code: "anchor_overlap" });
    expect(repository.listThreads(parent.chatId)).toHaveLength(1);
    expect(() => assertIdle()).not.toThrow();
  });

  it("reports new main messages without changing frozen context on read", async () => {
    const thread = await create();
    repository.appendMessage({ chatId: parent.chatId, threadId: null, role: "user", content: "Now consider a second device.", modelKey: "thinking" });
    const data = getThreadData(thread.id, repository);
    expect(data.context.newMessages).toBe(1);
    expect(data.thread.compressedContext).toBe(thread.compressedContext);
    expect(data.thread.contextFrozenAt).toBe(thread.contextFrozenAt);
  });

  it("does not create anything when preparation was cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(createThread({ parentMessageId: parent.id, anchorStart: 0, anchorEnd: 1, source: "user" }, { repository, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(repository.listThreads(parent.chatId)).toEqual([]);
    expect(() => assertIdle()).not.toThrow();
  });
});
