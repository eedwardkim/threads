import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as getAttachment } from "../../app/api/attachments/[id]/route";
import { DELETE as deleteAttachment, POST as uploadAttachment } from "../../app/api/attachments/route";
import { POST as generate } from "../../app/api/generate/route";
import { setAuthResolverForTests } from "../../lib/auth/server";
import { setDatabaseForTests } from "../../lib/db/client";
import type { ChatRepository } from "../../lib/db/repository";
import { attachments } from "../../lib/db/schema";
import * as provider from "../../lib/provider";
import type { ProviderChunk, StreamInput } from "../../lib/providers/types";
import type { Attachment, PromptMessage } from "../../lib/types";
import { png } from "../image-fixtures";
import { newUser, testDatabase } from "./harness";

const ORIGIN = "http://localhost:3000";

describe("attachments (Postgres)", () => {
  let repository: ChatRepository = newUser().repository;
  let userId = "";
  let chatId = "";

  beforeAll(() => setDatabaseForTests(testDatabase()));
  afterAll(() => setDatabaseForTests(undefined));

  beforeEach(async () => {
    const user = newUser();
    repository = user.repository;
    userId = user.userId;
    setAuthResolverForTests(async () => ({ id: userId, email: null }));
    chatId = (await repository.createChat()).id;
  });

  afterEach(() => {
    setAuthResolverForTests(undefined);
    vi.restoreAllMocks();
  });

  function create(overrides: Partial<Parameters<ChatRepository["createAttachment"]>[0]> = {}) {
    return repository.createAttachment({ chatId, name: "shot.png", mediaType: "image/png", width: 32, height: 16, data: png(32, 16), ...overrides });
  }

  function upload(body: Uint8Array<ArrayBuffer>, query = `chat=${chatId}&name=shot.png`, headers: Record<string, string> = {}) {
    return uploadAttachment(new Request(`${ORIGIN}/api/attachments?${query}`, { method: "POST", body: new Blob([body]), headers: { origin: ORIGIN, "content-type": "application/octet-stream", ...headers } }));
  }

  it("stores a validated upload as a pending attachment and serves it back only to its owner", async () => {
    const response = await upload(png(640, 480));
    expect(response.status).toBe(201);
    const { attachment } = await response.json() as { attachment: Attachment };
    expect(attachment).toMatchObject({ name: "shot.png", mediaType: "image/png", width: 640, height: 480, byteSize: 33, digest: null });

    const served = await getAttachment(new Request(`${ORIGIN}/api/attachments/${attachment.id}`), { params: Promise.resolve({ id: attachment.id }) });
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/png");
    expect(served.headers.get("cache-control")).toContain("private");
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(png(640, 480));

    const stranger = newUser();
    setAuthResolverForTests(async () => ({ id: stranger.userId, email: null }));
    expect((await getAttachment(new Request(`${ORIGIN}/api/attachments/${attachment.id}`), { params: Promise.resolve({ id: attachment.id }) })).status).toBe(404);
    expect(await stranger.repository.getAttachment(attachment.id)).toBeNull();
    expect(await stranger.repository.loadAttachments([attachment.id])).toEqual([]);
  });

  it("rejects uploads that are not images, are too large, or target another owner's chat", async () => {
    expect((await upload(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'></svg>"))).status).toBe(415);
    expect((await upload(png(8, 8), `chat=${chatId}&name=x.png`, { "content-length": String(7 * 1024 * 1024) })).status).toBe(413);
    expect((await upload(png(9000, 10))).status).toBe(415);
    const other = newUser();
    const otherChat = await other.repository.createChat();
    const response = await upload(png(8, 8), `chat=${otherChat.id}&name=x.png`);
    expect(response.status).toBe(404);
    expect(await other.repository.listMessages(otherChat.id, null)).toEqual([]);
  });

  it("claims only this chat's pending uploads when a user message is appended, in upload order", async () => {
    const first = await create({ name: "first.png" });
    const second = await create({ name: "second.png" });
    const otherChat = await repository.createChat();
    const elsewhere = await create({ chatId: otherChat.id });

    await expect(repository.appendMessage({ chatId, threadId: null, role: "user", content: "see", modelKey: "fast", attachmentIds: [first.id, elsewhere.id] }))
      .rejects.toMatchObject({ code: "attachment_not_found" });
    expect(await repository.listMessages(chatId, null)).toEqual([]);

    const message = await repository.appendMessage({ chatId, threadId: null, role: "user", content: "", modelKey: "fast", attachmentIds: [second.id, first.id] });
    expect(message.attachments?.map((attachment) => attachment.name)).toEqual(["first.png", "second.png"]);
    expect((await repository.getChat(chatId))?.title).toBe("Image");
    const [listed] = await repository.listMessages(chatId, null);
    expect(listed.attachments?.map((attachment) => attachment.id)).toEqual([first.id, second.id]);
    expect((await repository.getMessage(message.id))?.attachments).toHaveLength(2);

    // Claimed attachments cannot be reused, deleted, or reassigned.
    await expect(repository.appendMessage({ chatId, threadId: null, role: "user", content: "again", modelKey: "fast", attachmentIds: [first.id] }))
      .rejects.toMatchObject({ code: "attachment_not_found" });
    expect(await repository.deleteAttachment(first.id)).toBe(false);
    expect(await repository.getAttachment(first.id)).not.toBeNull();
    const immutable = { cause: expect.objectContaining({ constraint_name: "attachments_immutable" }) };
    await expect(testDatabase().db.update(attachments).set({ messageId: null }).where(eq(attachments.id, first.id))).rejects.toMatchObject(immutable);
    await expect(testDatabase().db.update(attachments).set({ data: png(1, 1) }).where(eq(attachments.id, first.id))).rejects.toMatchObject(immutable);
  });

  it("caches digests per attachment and deletes only pending uploads", async () => {
    const pending = await create();
    await repository.saveAttachmentDigest(pending.id, "Type: screenshot\nSummary: a tiny test image", "vision-test");
    expect((await repository.getAttachment(pending.id))?.digest).toContain("tiny test image");
    const [row] = await testDatabase().db.select({ model: attachments.digestModel }).from(attachments).where(and(eq(attachments.id, pending.id), eq(attachments.ownerId, userId)));
    expect(row.model).toBe("vision-test");

    const stranger = newUser();
    await stranger.repository.saveAttachmentDigest(pending.id, "stolen", "x");
    expect((await repository.getAttachment(pending.id))?.digest).toContain("tiny test image");
    expect(await stranger.repository.deleteAttachment(pending.id)).toBe(false);

    setAuthResolverForTests(async () => ({ id: userId, email: null }));
    const response = await deleteAttachment(new Request(`${ORIGIN}/api/attachments?id=${pending.id}`, { method: "DELETE", headers: { origin: ORIGIN } }));
    expect(await response.json()).toEqual({ deleted: true });
    expect(await repository.getAttachment(pending.id)).toBeNull();
  });

  it("feeds the model a native image or a cached digest and never changes persisted content", async () => {
    const prompts: PromptMessage[][] = [];
    vi.spyOn(provider, "getProviderStatus").mockReturnValue({ mock: true, deepseek: false, anthropic: false, openai: false });
    vi.spyOn(provider, "streamChat").mockImplementation(async function* (input: StreamInput): AsyncGenerator<ProviderChunk> {
      prompts.push(structuredClone(input.messages.map(({ images, ...rest }) => ({ ...rest, images: images?.map((image) => ({ ...image, data: image.data.length })) })) as PromptMessage[]));
      yield { type: "text", text: "I see it." };
      yield { type: "usage", inputTokens: 1, outputTokens: 1 };
    });
    const image = await create({ name: "chart.png" });
    const request = async (body: Record<string, unknown>) => {
      const response = await generate(new Request(`${ORIGIN}/api/generate`, {
        method: "POST", headers: { "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify({ requestId: crypto.randomUUID(), chatId, threadId: null, modelKey: "deepseek-pro", ...body }),
      }));
      const lines = (await response.text()).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { type: string });
      return { status: response.status, last: lines.at(-1)?.type };
    };

    expect(await request({ content: "What does the chart show?", attachmentIds: [image.id] })).toEqual({ status: 200, last: "finish" });

    const [user, assistant] = await repository.listMessages(chatId, null);
    expect(user.content).toBe("What does the chart show?");
    expect(user.attachments?.[0].id).toBe(image.id);
    expect(user.attachments?.[0].digest).toMatch(/mock/i);
    expect(assistant.content).toBe("I see it.");
    const last = prompts[0].at(-1)!;
    expect(last.content).toBe("What does the chart show?");
    expect(last.attachments?.[0].digest).toMatch(/32×16/);
    expect(last.images).toBeUndefined();

    // A second image in a later turn cannot reuse the claimed one, and the cached digest is reused, not rewritten.
    expect((await request({ content: "again", attachmentIds: [image.id] })).status).toBe(404);
    expect(await request({ content: "and now?" })).toEqual({ status: 200, last: "finish" });
    expect(prompts[1].find((turn) => turn.attachments?.length)?.attachments?.[0].digest).toMatch(/mock/i);

    // Retries cannot smuggle new attachments in.
    expect((await request({ retryMessageId: assistant.id, attachmentIds: [image.id] })).status).toBe(400);
  });
});
