import { beforeEach, describe, expect, it } from "vitest";
import type { GenerationStore } from "../../lib/db/jobs";
import type { ChatRepository } from "../../lib/db/repository";
import { createThread, getThreadData } from "../../lib/thread-service";
import type { Message } from "../../lib/types";
import { newUser } from "./harness";

let repository: ChatRepository;
let jobs: GenerationStore;
let parent: Message;

beforeEach(async () => {
  ({ repository, jobs } = newUser());
  const chat = await repository.createChat();
  await repository.appendMessage({ chatId: chat.id, threadId: null, role: "user", content: "Explain the boundaries.", modelKey: "fast" });
  parent = await repository.appendMessage({ chatId: chat.id, threadId: null, role: "assistant", content: "A **durable boundary** makes recovery predictable.\n\nKeep the read path local.", modelKey: "fast" });
});

function create() {
  return createThread({ parentMessageId: parent.id, anchorStart: 2, anchorEnd: 22, source: "user" }, { repository, jobs });
}

async function idle() {
  expect(await jobs.listRunning()).toEqual([]);
}

describe("single thread-creation entry point", () => {
  it("freezes a briefing and opens an anchored thread without sending any message", async () => {
    const thread = await create();
    const data = await getThreadData(thread.id, repository);
    expect(thread.anchorExact).toBe(parent.content.slice(2, 22));
    expect(thread.source).toBe("user");
    expect(thread.contextFrozenAt).toBe(parent.createdAt);
    expect(thread.compressedContext).not.toBeNull();
    expect(data.messages).toEqual([]);
    expect(await repository.listMessages(parent.chatId)).toHaveLength(2);
    await idle();
  });

  it("rejects overlaps and leaves no running context job after a failure", async () => {
    await create();
    await expect(create()).rejects.toMatchObject({ code: "anchor_overlap" });
    expect(await repository.listThreads(parent.chatId)).toHaveLength(1);
    await idle();
  });

  it("reports new main messages without changing frozen context on read", async () => {
    const thread = await create();
    await repository.appendMessage({ chatId: parent.chatId, threadId: null, role: "user", content: "Now consider a second device.", modelKey: "thinking" });
    const data = await getThreadData(thread.id, repository);
    expect(data.context.newMessages).toBe(1);
    expect(data.thread.compressedContext).toBe(thread.compressedContext);
    expect(data.thread.contextFrozenAt).toBe(thread.contextFrozenAt);
  });

  it("does not create anything when preparation was cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(createThread({ parentMessageId: parent.id, anchorStart: 0, anchorEnd: 1, source: "user" }, { repository, jobs, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(await repository.listThreads(parent.chatId)).toEqual([]);
    await idle();
  });

  it("does not let another owner open a thread on this user's message", async () => {
    const intruder = newUser();
    await expect(createThread({ parentMessageId: parent.id, anchorStart: 2, anchorEnd: 22, source: "user" }, { repository: intruder.repository, jobs: intruder.jobs })).rejects.toMatchObject({ code: "message_not_found" });
    expect(await repository.listThreads(parent.chatId)).toEqual([]);
  });
});
