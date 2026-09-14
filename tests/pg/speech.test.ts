import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as speech } from "../../app/api/speech/route";
import { setAuthResolverForTests } from "../../lib/auth/server";
import { setDatabaseForTests } from "../../lib/db/client";
import type { ChatRepository } from "../../lib/db/repository";
import { SPEECH_PIPELINE_VERSION, speechChunks } from "../../lib/speech/speakable";
import { newUser, testDatabase } from "./harness";

const CONTENT = "# Title\n\nFirst paragraph with $x^2$.\n\n" + "Another sentence that keeps the passage going. ".repeat(30);

describe("GET /api/speech", () => {
  let repository: ChatRepository = newUser().repository;
  let userId = "";

  beforeAll(() => setDatabaseForTests(testDatabase()));
  afterAll(() => setDatabaseForTests(undefined));

  beforeEach(() => {
    vi.stubEnv("USE_MOCK", "true");
    vi.stubEnv("THREADS_SPEECH_PROVIDER", "mock");
    const user = newUser();
    repository = user.repository;
    userId = user.userId;
    setAuthResolverForTests(async () => ({ id: user.userId, email: `${user.userId}@example.test` }));
  });

  afterEach(() => { setAuthResolverForTests(undefined); vi.unstubAllEnvs(); });

  const request = (query: Record<string, string>) => new Request(`http://localhost:3000/api/speech?${new URLSearchParams(query)}`);

  async function completedMessage() {
    const chat = await repository.createChat();
    return repository.appendMessage({ chatId: chat.id, threadId: null, role: "assistant", content: CONTENT, modelKey: "fast", complete: true });
  }

  it("describes the configured voice service", async () => {
    const response = await speech(new Request("http://localhost:3000/api/speech"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ provider: "mock", voices: [{ id: "mock", label: "Mock voice" }], defaultVoice: "mock" });
  });

  it("streams immutable audio for one chunk of an owned, completed message", async () => {
    const message = await completedMessage();
    const chunks = speechChunks(CONTENT);
    expect(chunks.length).toBeGreaterThan(1);
    const response = await speech(request({ message: message.id, chunk: "1", voice: "nonexistent", v: String(SPEECH_PIPELINE_VERSION) }));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("audio/wav");
    expect(response.headers.get("cache-control")).toContain("immutable");
    expect(response.headers.get("x-speech-chunks")).toBe(String(chunks.length));
    expect(response.headers.get("x-speech-voice")).toBe("mock");
    const audio = new Uint8Array(await response.arrayBuffer());
    expect(new TextDecoder().decode(audio.slice(0, 4))).toBe("RIFF");
    expect((await speech(request({ message: message.id, chunk: String(chunks.length) }))).status).toBe(404);
  });

  it("refuses incomplete messages, stale clients, other owners and bad input", async () => {
    const chat = await repository.createChat();
    const partial = await repository.appendMessage({ chatId: chat.id, threadId: null, role: "assistant", content: "Still writing", modelKey: "fast", complete: false });
    expect((await speech(request({ message: partial.id, chunk: "0" }))).status).toBe(409);
    const message = await completedMessage();
    expect((await speech(request({ message: message.id, chunk: "0", v: String(SPEECH_PIPELINE_VERSION + 1) }))).status).toBe(409);
    expect((await speech(request({ message: message.id, chunk: "-1" }))).status).toBe(400);
    expect((await speech(request({ message: message.id }))).status).toBe(400);

    const stranger = newUser();
    setAuthResolverForTests(async () => ({ id: stranger.userId, email: `${stranger.userId}@example.test` }));
    expect(stranger.userId).not.toBe(userId);
    expect((await speech(request({ message: message.id, chunk: "0" }))).status).toBe(404);
  });

  it("explains when no voice service is configured", async () => {
    vi.stubEnv("THREADS_SPEECH_PROVIDER", "");
    vi.stubEnv("USE_MOCK", "false");
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("ELEVENLABS_API_KEY", "");
    const message = await completedMessage();
    expect(await (await speech(new Request("http://localhost:3000/api/speech"))).json()).toEqual({ provider: null, voices: [], defaultVoice: null });
    const response = await speech(request({ message: message.id, chunk: "0" }));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "speech_unconfigured" });
  });
});
