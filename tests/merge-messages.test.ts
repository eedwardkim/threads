import { describe, expect, it } from "vitest";
import { mergeMessages } from "../lib/merge-messages";
import type { Message } from "../lib/types";
import type { StreamSession } from "../lib/stream-store";

const message: Message = { id: "answer", chatId: "chat", threadId: null, role: "assistant", content: "Partial", modelKey: "fast", complete: false, inputTokens: null, outputTokens: null, createdAt: 2 };
const session: StreamSession = { requestId: "request", chatId: "chat", threadId: null, phase: "idle", userMessage: null, message: { ...message, content: "Partial answer, finished.", complete: true }, error: null };

describe("stream-to-database handoff", () => {
  it("never shows another chat's stream", () => {
    expect(mergeMessages([message], { ...session, chatId: "other" }, "chat")).toEqual([message]);
  });

  it("does not briefly revert to stale partial content while a refetch is pending", () => {
    expect(mergeMessages([message], session, "chat")[0]).toEqual(session.message);
  });

  it("prefers the persisted partial when it contains a chunk the disconnected client never received", () => {
    const saved = { ...message, content: "Partial answer from the server" };
    expect(mergeMessages([saved], { ...session, message }, "chat")[0]).toEqual(saved);
  });

  it("preserves an immutable completed database message", () => {
    const saved = { ...message, complete: true, content: "The finished answer" };
    expect(mergeMessages([saved], session, "chat")[0]).toEqual(saved);
  });

  it("merges newly accepted messages without mutating the source array", () => {
    const original: Message[] = [];
    const user = { ...message, id: "question", createdAt: 1, role: "user" as const, complete: true };
    const result = mergeMessages(original, { ...session, phase: "streaming", userMessage: user }, "chat");
    expect(result.map((item) => item.id)).toEqual(["question", "answer"]);
    expect(original).toEqual([]);
  });
});
