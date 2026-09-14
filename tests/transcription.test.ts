// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { insertDictation, MAX_DICTATION_BYTES } from "../lib/dictation";
import { readDictation, transcribe, transcriptionProvider } from "../lib/transcription";
import { setAuthResolverForTests } from "../lib/auth/server";
import { GET, POST } from "../app/api/transcribe/route";

beforeEach(() => {
  vi.stubEnv("USE_MOCK", "false");
  vi.stubEnv("OPENAI_API_KEY", "test-key");
  vi.stubEnv("ELEVENLABS_API_KEY", undefined);
  vi.stubEnv("THREADS_TRANSCRIPTION_MODEL", undefined);
  vi.stubEnv("THREADS_TRANSCRIPTION_PROVIDER", undefined);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); setAuthResolverForTests(undefined); });

function recording(size = 64) {
  const bytes = new Uint8Array(size);
  bytes.set([0x1a, 0x45, 0xdf, 0xa3]);
  return new Blob([bytes], { type: "audio/webm" });
}
const options = { context: "Eigenvalues of a matrix", terms: "CS61A, eigenvector", language: "en" };

it("uses full-recording OpenAI transcription with bounded relevant context and literal keywords", async () => {
  const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
    const form = init.body as FormData;
    expect(form.get("model")).toBe("gpt-transcribe");
    expect(form.get("prompt")).toBe(options.context);
    expect(form.getAll("keywords[]")).toEqual(["CS61A", "eigenvector"]);
    expect(form.get("languages[]")).toBe("en");
    expect(form.get("language")).toBeNull();
    expect((form.get("file") as File).size).toBe(64);
    return Response.json({ text: "An eigenvector." });
  });
  vi.stubGlobal("fetch", fetcher);
  expect(await transcribe(recording(), options, new AbortController().signal)).toEqual({ text: "An eigenvector.", provider: "openai" });
  expect(fetcher).toHaveBeenCalledOnce();
});

it("supports a server-selected legacy OpenAI model without new-only fields", async () => {
  vi.stubEnv("THREADS_TRANSCRIPTION_MODEL", "gpt-4o-transcribe");
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    const form = init.body as FormData;
    expect(form.get("language")).toBe("en");
    expect(form.get("keywords[]")).toBeNull();
    expect(form.get("prompt")).toContain("eigenvector");
    return Response.json({ text: "A matrix." });
  });
  await transcribe(recording(), options, new AbortController().signal);
});

it("adapts Scribe vocabulary and disables sound-effect tags and diarization", async () => {
  vi.stubEnv("THREADS_TRANSCRIPTION_PROVIDER", "elevenlabs");
  vi.stubEnv("ELEVENLABS_API_KEY", "test-key");
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    expect(url).toBe("https://api.elevenlabs.io/v1/speech-to-text");
    const form = init.body as FormData;
    expect(form.getAll("keyterms")).toEqual(["CS61A", "eigenvector"]);
    expect(form.get("model_id")).toBe("scribe_v2");
    expect(form.get("tag_audio_events")).toBe("false");
    return Response.json({ text: "Hello." });
  });
  expect((await transcribe(recording(), options, new AbortController().signal)).provider).toBe("elevenlabs");
});

it("rejects invalid audio and bounded uploads even without content-length", async () => {
  const request = (blob: Blob) => new Request("https://app.test/api/transcribe", { method: "POST", body: blob });
  expect((await readDictation(request(recording()))).size).toBe(64);
  await expect(readDictation(request(new Blob(["x".repeat(64)], { type: "audio/webm" })))).rejects.toMatchObject({ code: "invalid_audio" });
  await expect(readDictation(request(recording(MAX_DICTATION_BYTES + 1)))).rejects.toMatchObject({ status: 413 });
});

it("never echoes provider errors or credentials and does not return invented text for silence", async () => {
  vi.stubGlobal("fetch", async () => new Response("sensitive upstream details", { status: 401 }));
  await expect(transcribe(recording(), options, new AbortController().signal)).rejects.toMatchObject({ code: "transcription_failed" });
  vi.stubGlobal("fetch", async () => Response.json({ text: " " }));
  await expect(transcribe(recording(), options, new AbortController().signal)).rejects.toMatchObject({ code: "no_speech" });
});

it("requires identity and same-origin before reading audio or calling providers", async () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  setAuthResolverForTests(async () => null);
  expect((await GET()).status).toBe(401);
  expect((await POST(new Request("https://app.test/api/transcribe", { method: "POST", body: recording() }))).status).toBe(401);
  expect((await POST(new Request("https://app.test/api/transcribe", { method: "POST", body: recording(), headers: { origin: "https://evil.test" } }))).status).toBe(403);
  expect(fetcher).not.toHaveBeenCalled();
});

it("does not silently switch providers or enable mocks", () => {
  vi.stubEnv("THREADS_TRANSCRIPTION_PROVIDER", "elevenlabs");
  expect(transcriptionProvider()).toBeNull();
  vi.stubEnv("THREADS_TRANSCRIPTION_PROVIDER", undefined);
  vi.stubEnv("OPENAI_API_KEY", undefined);
  expect(transcriptionProvider()).toBeNull();
  vi.stubEnv("USE_MOCK", "true");
  expect(transcriptionProvider()).toBe("mock");
});

it("inserts at the selection without replacing unrelated draft text", () => {
  expect(insertDictation("The bad vector.", "eigen", 4, 7).text).toBe("The eigen vector.");
  expect(insertDictation("Hello", "world", 5, 5)).toEqual({ text: "Hello world", cursor: 11 });
  expect(insertDictation("", "Hi.", 0, 0).text).toBe("Hi.");
});
