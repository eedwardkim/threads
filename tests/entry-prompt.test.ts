import { afterEach, describe, expect, it, vi } from "vitest";
import { saveEntryPrompt, takeEntryPrompt } from "../lib/entry-prompt";
import { clearPrivateClientState } from "../lib/client-state";

afterEach(() => { sessionStorage.clear(); vi.useRealTimers(); });

describe("landing prompt handoff", () => {
  it("hands Unicode text to exactly one composer in the matching chat", () => {
    saveEntryPrompt("owner-a", "chat-a", "What does ψ mean?\nExplain with an example.");
    expect(takeEntryPrompt("owner-a", "chat-b")).toBeNull();
    expect(takeEntryPrompt("owner-a", "chat-a")).toBe("What does ψ mean?\nExplain with an example.");
    expect(takeEntryPrompt("owner-a", "chat-a")).toBeNull();
  });

  it("discards another account's pending prompt", () => {
    saveEntryPrompt("owner-a", "chat-a", "private draft");
    expect(takeEntryPrompt("owner-b", "chat-a")).toBeNull();
    expect(takeEntryPrompt("owner-a", "chat-a")).toBeNull();
  });

  it("discards old or future-dated drafts", () => {
    vi.useFakeTimers();
    const now = Date.now();
    saveEntryPrompt("owner-a", "chat-a", "old");
    vi.setSystemTime(now + 300_001);
    expect(takeEntryPrompt("owner-a", "chat-a")).toBeNull();
    saveEntryPrompt("owner-a", "chat-a", "future");
    vi.setSystemTime(now);
    expect(takeEntryPrompt("owner-a", "chat-a")).toBeNull();
  });

  it("clears pending text on sign-out without removing unrelated preferences", () => {
    saveEntryPrompt("owner-a", "chat-a", "private draft");
    sessionStorage.setItem("other-preference", "keep");
    clearPrivateClientState();
    expect(sessionStorage.getItem("threads:entry:chat-a")).toBeNull();
    expect(sessionStorage.getItem("other-preference")).toBe("keep");
  });

  it("rejects malformed or oversized stored text", () => {
    sessionStorage.setItem("threads:entry:chat-a", "{broken");
    expect(takeEntryPrompt("owner-a", "chat-a")).toBeNull();
    saveEntryPrompt("owner-a", "chat-a", "a".repeat(4001));
    expect(takeEntryPrompt("owner-a", "chat-a")).toBeNull();
  });
});
