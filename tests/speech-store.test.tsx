import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearPrivateClientState } from "../lib/client-state";
import { speechStore } from "../lib/speech-store";
import { speechChunks } from "../lib/speech/speakable";
import type { Message } from "../lib/types";

const CONTENT = "# Intro\n\nOpening paragraph.\n\n" + Array.from({ length: 30 }, (_, i) => `Paragraph ${i} carries on with a few more words in it to fill space.`).join("\n\n");

function message(input: Partial<Message> = {}): Message {
  return { id: "m1", chatId: "chat", threadId: null, role: "assistant", content: CONTENT, modelKey: "fast", complete: true, inputTokens: null, outputTokens: null, createdAt: 1, ...input };
}

/** The store keeps one `<audio>` element for its lifetime, so the first FakeAudio is shared by every test. */
const fired: HTMLAudioElement[] = [];

class FakeAudio extends EventTarget {
  src = "";
  playbackRate = 1;
  preload = "";
  paused = true;
  constructor() { super(); fired.push(this as unknown as HTMLAudioElement); }
  play() { this.paused = false; queueMicrotask(() => this.dispatchEvent(new Event("playing"))); return Promise.resolve(); }
  pause() { this.paused = true; }
  load() {}
  removeAttribute(name: string) { if (name === "src") this.src = ""; }
}

describe("speech store", () => {
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(() => {
    vi.stubGlobal("Audio", FakeAudio);
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => `blob:${Math.random()}`), revokeObjectURL: vi.fn() }));
    fetchMock = vi.fn<typeof fetch>(async () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "audio/wav" } }));
    vi.stubGlobal("fetch", fetchMock);
    window.localStorage.clear();
  });

  afterEach(() => {
    act(() => speechStore.stop());
    vi.unstubAllGlobals();
  });

  it("plays chunk by chunk, streaming the first and prefetching the next", async () => {
    const chunks = speechChunks(CONTENT);
    expect(chunks.length).toBeGreaterThan(3);
    await act(async () => { speechStore.toggle(message()); });
    const audio = fired[0];
    expect(speechStore.getSnapshot()).toMatchObject({ messageId: "m1", status: "playing", chunk: 0 });
    expect(audio.src).toBe("/api/speech?message=m1&chunk=0&v=1");
    await act(async () => { await Promise.resolve(); });
    const prefetched = fetchMock.mock.calls.map(([url]) => String(url));
    expect(prefetched).toEqual(["/api/speech?message=m1&chunk=1&v=1", "/api/speech?message=m1&chunk=2&v=1"]);

    await act(async () => { audio.dispatchEvent(new Event("ended")); await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(speechStore.getSnapshot()).toMatchObject({ status: "playing", chunk: 1 });
    expect(audio.src).toMatch(/^blob:/);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toContain("/api/speech?message=m1&chunk=3&v=1");
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("chunk=1"))).toHaveLength(1);
  });

  it("toggles pause and resume on the same message and stops at the end", async () => {
    await act(async () => { speechStore.toggle(message({ content: "Just one short line." })); });
    expect(speechStore.getSnapshot().chunks).toHaveLength(1);
    act(() => speechStore.toggle(message({ content: "Just one short line." })));
    expect(speechStore.getSnapshot().status).toBe("paused");
    expect(fired[0].paused).toBe(true);
    await act(async () => { speechStore.toggle(message({ content: "Just one short line." })); });
    expect(speechStore.getSnapshot().status).toBe("playing");
    act(() => fired[0].dispatchEvent(new Event("ended")));
    expect(speechStore.getSnapshot()).toMatchObject({ status: "idle", messageId: null });
  });

  it("persists speed and voice preferences and restarts the current chunk on a voice change", async () => {
    await act(async () => { speechStore.toggle(message()); });
    act(() => speechStore.setRate(1.5));
    expect(fired[0].playbackRate).toBe(1.5);
    expect(window.localStorage.getItem("threads:speech:rate")).toBe("1.5");
    act(() => speechStore.setRate(7));
    expect(speechStore.getSnapshot().rate).toBe(1.5);
    await act(async () => { speechStore.setVoice("cedar"); });
    expect(window.localStorage.getItem("threads:speech:voice")).toBe("cedar");
    expect(fired[0].src).toBe("/api/speech?message=m1&chunk=0&v=1&voice=cedar");
    expect(speechStore.getSnapshot()).toMatchObject({ status: "playing", chunk: 0, voice: "cedar" });
  });

  it("surfaces the server's explanation when audio fails and clears on sign-out", async () => {
    fetchMock.mockImplementation(async () => Response.json({ error: "Wait for the response to finish before listening.", code: "incomplete" }, { status: 409 }));
    await act(async () => { speechStore.toggle(message()); });
    await act(async () => { fired[0].dispatchEvent(new Event("error")); await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(speechStore.getSnapshot()).toMatchObject({ status: "error", error: "Wait for the response to finish before listening." });
    act(() => clearPrivateClientState());
    expect(speechStore.getSnapshot().status).toBe("idle");
  });

  it("reports an empty message instead of calling the server", async () => {
    await act(async () => { speechStore.toggle(message({ content: "```\nonly code\n```" })); });
    expect(speechStore.getSnapshot().status).toBe("playing");
    act(() => speechStore.stop());
    act(() => speechStore.toggle(message({ content: "   " })));
    expect(speechStore.getSnapshot()).toMatchObject({ status: "error", error: "There is nothing to read in this message." });
    expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining("message=m1&chunk=0"), expect.anything());
  });
});
