import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { compress, streamChat } from "../lib/provider";
import { COMPRESSION_MODEL, modelFor, type ModelKey } from "../lib/models";
import { readableError } from "../lib/errors";
import type { Briefing, PromptMessage } from "../lib/types";
import type { ProviderChunk } from "../lib/providers/types";

let transport: ReturnType<typeof vi.fn<typeof fetch>>;
const messages: PromptMessage[] = [{ role: "system", content: "A stable prefix." }, { role: "user", content: "Explain this boundary." }];
const briefing: Briefing = { goal: "Build a durable local app", constraints: ["Keep reads local"], decisions: ["Use SQLite"], artifacts: ["saveNote"], open_questions: ["How should retries work?"] };

function event(delta: Record<string, unknown>, finish: string | null = null) {
  return { id: "fixture", model: modelFor("fast").id, created: 1, choices: [{ index: 0, delta, finish_reason: finish }] };
}

function sse(parts: unknown[], done = true) {
  return new Response(parts.map((part) => `data: ${JSON.stringify(part)}\n\n`).join("") + (done ? "data: [DONE]\n\n" : ""), { headers: { "Content-Type": "text/event-stream" } });
}

function answer(finish = "stop", includeUsage = true) {
  return sse([
    event({ role: "assistant" }),
    event({ reasoning_content: "Provider reasoning is not part of the saved answer." }),
    event({ content: "## Verified\n\n" }),
    event({ content: "**Answer**" }),
    event({}, finish),
    ...(includeUsage ? [{ choices: [], usage: { prompt_tokens: 120, completion_tokens: 35, total_tokens: 155 } }] : []),
  ]);
}

function jsonResponse(text: string) {
  return Response.json({ id: "fixture", model: COMPRESSION_MODEL, created: 1, choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 } });
}

function requestBody() {
  return JSON.parse(transport.mock.calls[0][1]?.body as string) as Record<string, unknown>;
}

async function collect(modelKey: ModelKey = "fast", signal?: AbortSignal) {
  const chunks: ProviderChunk[] = [];
  for await (const chunk of streamChat({ messages, modelKey, signal })) chunks.push(chunk);
  return chunks;
}

beforeEach(() => {
  vi.stubEnv("USE_MOCK", "false");
  vi.stubEnv("DEEPSEEK_API_KEY", "fixture-only-not-a-real-key");
  transport = vi.fn<typeof fetch>().mockRejectedValue(new Error("No HTTP fixture installed"));
  vi.stubGlobal("fetch", transport);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("DeepSeek HTTP adapter", () => {
  it.each(["fast", "thinking"] as const)("uses Chat Completions, correct thinking parameters, and usage for %s", async (key) => {
    transport.mockResolvedValue(answer());
    const chunks = await collect(key);
    expect(transport.mock.calls[0][0]).toBe("https://api.deepseek.com/chat/completions");
    expect(new Headers(transport.mock.calls[0][1]?.headers).get("authorization")).toBe("Bearer fixture-only-not-a-real-key");
    expect(requestBody()).toMatchObject({ model: modelFor(key).id, messages, stream: true, thinking: { type: key === "thinking" ? "enabled" : "disabled" }, stream_options: { include_usage: true } });
    expect(chunks.filter((chunk) => chunk.type === "text").map((chunk) => chunk.text).join("")).toBe("## Verified\n\n**Answer**");
    expect(chunks.at(-1)).toEqual({ type: "usage", inputTokens: 120, outputTokens: 35 });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("keeps parent and subject in order without promoting quoted data to system instructions", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    transport.mockResolvedValue(answer());
    const prompt: PromptMessage[] = [
      { role: "system", content: "Frozen briefing" },
      { role: "assistant", content: "Verbatim **parent**\n\nKeep all of it." },
      { role: "system", content: "Thread subject:\n**parent**" },
      { role: "user", content: "A focused question" },
    ];
    const chunks: ProviderChunk[] = [];
    for await (const chunk of streamChat({ messages: prompt, modelKey: "fast" })) chunks.push(chunk);
    expect(requestBody().messages).toEqual([prompt[0], prompt[1], { ...prompt[2], role: "user" }, prompt[3]]);
    expect(chunks.some((chunk) => chunk.type === "text")).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it("keeps the main prefix byte-stable across requests", async () => {
    transport.mockImplementation(async () => answer());
    await collect();
    const first = requestBody().messages;
    for await (const chunk of streamChat({ modelKey: "thinking", messages: [...messages, { role: "assistant", content: "Saved answer" }, { role: "user", content: "Next question" }] })) {
      expect(chunk.type).toMatch(/text|usage/);
    }
    const second = JSON.parse(transport.mock.calls[1][1]?.body as string) as { messages: PromptMessage[] };
    expect(JSON.stringify(second.messages.slice(0, messages.length))).toBe(JSON.stringify(first));
  });

  it.each(["main-to-thread", "thread-to-main"] as const)("compresses %s with structured JSON mode and the compression model", async (direction) => {
    transport.mockResolvedValue(jsonResponse(JSON.stringify(briefing)));
    expect(await compress({ messages, direction })).toEqual(briefing);
    expect(requestBody()).toMatchObject({ model: COMPRESSION_MODEL, thinking: { type: "disabled" }, response_format: { type: "json_object" }, max_tokens: 2048 });
    expect(JSON.stringify(requestBody().messages)).toContain(direction);
    expect(JSON.stringify(requestBody().messages)).toContain("open_questions");
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed compression JSON so the data layer can fall back", async () => {
    transport.mockResolvedValue(jsonResponse("not JSON"));
    await expect(compress({ messages, direction: "main-to-thread" })).rejects.toThrow();
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("rejects a structurally invalid compression object", async () => {
    transport.mockResolvedValue(jsonResponse('{"goal":42}'));
    await expect(compress({ messages, direction: "main-to-thread" })).rejects.toThrow();
  });

  it.each([[401, "invalid_key"], [429, "rate_limit"], [503, "busy"]] as const)("preserves HTTP %s without automatic retries", async (status, code) => {
    transport.mockResolvedValue(Response.json({ error: { message: "Provider rejected the request", type: "api_error", code: "fixture" } }, { status }));
    const error = await collect().then(() => null, (error: unknown) => error);
    expect(readableError(error)).toMatchObject({ status, code });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("keeps visible text and rejects an EOF without a completion reason", async () => {
    transport.mockResolvedValue(sse([event({ content: "Partial answer" })], false));
    const chunks: ProviderChunk[] = [];
    let failure: unknown;
    try {
      for await (const chunk of streamChat({ messages, modelKey: "fast" })) chunks.push(chunk);
    } catch (error) { failure = error; }
    expect(chunks).toContainEqual({ type: "text", text: "Partial answer" });
    expect(failure).toMatchObject({ code: "incomplete_response" });
  });

  it("reports a token-limited answer as incomplete while preserving its measured usage", async () => {
    transport.mockResolvedValue(answer("length"));
    const chunks: ProviderChunk[] = [];
    let failure: unknown;
    try {
      for await (const chunk of streamChat({ messages, modelKey: "thinking" })) chunks.push(chunk);
    } catch (error) { failure = error; }
    expect(chunks.at(-1)).toEqual({ type: "usage", inputTokens: 120, outputTokens: 35 });
    expect(failure).toMatchObject({ code: "response_limit" });
  });

  it("does not invent token usage when the server omits it", async () => {
    transport.mockResolvedValue(answer("stop", false));
    expect((await collect()).every((chunk) => chunk.type === "text")).toBe(true);
  });

  it("does not silently accept an empty final answer", async () => {
    transport.mockResolvedValue(sse([event({}, "stop")]));
    await expect(collect("thinking")).rejects.toMatchObject({ code: "empty_response" });
  });

  it("forwards Stop to the HTTP request", async () => {
    transport.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Stopped", "AbortError")), { once: true });
    }));
    const controller = new AbortController();
    const settled = collect("fast", controller.signal).then(() => null, (error: unknown) => error);
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
    controller.abort();
    expect(await settled).toMatchObject({ name: "AbortError" });
    expect(transport.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it("does not contact the live API when mock mode is unset", async () => {
    vi.stubEnv("USE_MOCK", undefined);
    vi.stubEnv("DEEPSEEK_API_KEY", undefined);
    const controller = new AbortController();
    controller.abort();
    expect(await collect("fast", controller.signal)).toEqual([]);
    expect(transport).not.toHaveBeenCalled();
  });
});
