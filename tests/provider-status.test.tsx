import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderBanner } from "../components/provider-banner";
import { readableError } from "../lib/errors";
import { modelFor } from "../lib/models";
import { getProviderStatus, requireProviderAvailable, streamChat, compressionProvider } from "../lib/provider";
import type { ProviderChunk } from "../lib/providers/types";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("server-only provider status", () => {
  it("never enables mock inference implicitly; USE_MOCK=true is an explicit opt-in", () => {
    vi.stubEnv("USE_MOCK", undefined);
    vi.stubEnv("DEEPSEEK_API_KEY", undefined);
    vi.stubEnv("ANTHROPIC_API_KEY", undefined);
    vi.stubEnv("OPENAI_API_KEY", undefined);
    expect(getProviderStatus()).toEqual({ mock: false, deepseek: false, anthropic: false, openai: false });
    expect(() => requireProviderAvailable("fast")).toThrowError(expect.objectContaining({ code: "missing_key" }));
    vi.stubEnv("USE_MOCK", "true");
    expect(getProviderStatus()).toEqual({ mock: true, deepseek: false, anthropic: false, openai: false });
  });

  it("refuses mock inference in a production deployment", () => {
    vi.stubEnv("USE_MOCK", "true");
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("THREADS_ALLOW_MOCK_IN_PRODUCTION", undefined);
    expect(() => getProviderStatus()).toThrowError(expect.objectContaining({ code: "mock_forbidden" }));
  });

  it("chooses the compression provider from configured credentials", () => {
    vi.stubEnv("USE_MOCK", "false");
    vi.stubEnv("THREADS_COMPRESSION_PROVIDER", undefined);
    vi.stubEnv("DEEPSEEK_API_KEY", undefined);
    vi.stubEnv("ANTHROPIC_API_KEY", "test-only-not-a-real-key");
    vi.stubEnv("OPENAI_API_KEY", undefined);
    expect(compressionProvider()).toBe("anthropic");
    vi.stubEnv("THREADS_COMPRESSION_PROVIDER", "openai");
    expect(compressionProvider()).toBeNull();
    vi.stubEnv("THREADS_COMPRESSION_PROVIDER", "nope");
    expect(() => compressionProvider()).toThrowError(expect.objectContaining({ code: "invalid_config" }));
  });

  it("returns only booleans and never the API key", () => {
    vi.stubEnv("USE_MOCK", "false");
    vi.stubEnv("DEEPSEEK_API_KEY", "test-only-not-a-real-key");
    vi.stubEnv("ANTHROPIC_API_KEY", undefined);
    vi.stubEnv("OPENAI_API_KEY", undefined);
    expect(getProviderStatus()).toEqual({ mock: false, deepseek: true, anthropic: false, openai: false });
    expect(JSON.stringify(getProviderStatus())).not.toContain("test-only-not-a-real-key");
  });

  it("reports each provider independently", () => {
    vi.stubEnv("USE_MOCK", "false");
    vi.stubEnv("DEEPSEEK_API_KEY", "deepseek-key");
    vi.stubEnv("ANTHROPIC_API_KEY", "anthropic-key");
    vi.stubEnv("OPENAI_API_KEY", "openai-key");
    expect(getProviderStatus()).toEqual({ mock: false, deepseek: true, anthropic: true, openai: true });
  });

  it("names the missing variable and how to recover", () => {
    const html = renderToStaticMarkup(<ProviderBanner status={{ mock: false, deepseek: false, anthropic: false, openai: false }} />);
    expect(html).toContain('role="alert"');
    expect(html).toContain("DEEPSEEK_API_KEY");
    expect(html).toContain("ANTHROPIC_API_KEY");
    expect(html).toContain("OPENAI_API_KEY");
    expect(html).toContain(".env.local");
    expect(html).toContain("USE_MOCK=true");
  });

  it("renders a rejected-key banner for a 401 notice", () => {
    expect(renderToStaticMarkup(<ProviderBanner status={{ mock: false, deepseek: true, anthropic: false, openai: false }} errorCode="invalid_key" />)).toContain("Your API key was rejected.");
  });

  it("does not ask for a key in mock mode", () => {
    expect(renderToStaticMarkup(<ProviderBanner status={{ mock: true, deepseek: false, anthropic: false, openai: false }} />)).toBe("");
  });

  it("does not show a banner when at least one provider is configured", () => {
    expect(renderToStaticMarkup(<ProviderBanner status={{ mock: false, deepseek: false, anthropic: true, openai: false }} />)).toBe("");
  });
});

describe("model names", () => {
  it.each([
    ["fast", "DeepSeek Flash (Fast)"],
    ["thinking", "DeepSeek Flash (Thinking)"],
    ["opus", "Opus 4.8"],
    ["sonnet", "Sonnet 4.5"],
    ["haiku", "Haiku 4.5"],
    ["gpt-5", "GPT-5 (original)"],
    ["gpt-5-mini", "GPT-5 mini"],
  ] as const)("identifies the configured %s model", (key, label) => {
    expect(modelFor(key).label).toBe(label);
  });
});

describe("provider routing", () => {
  it("throws missing_key for a model whose provider env var is absent", () => {
    vi.stubEnv("USE_MOCK", "false");
    vi.stubEnv("DEEPSEEK_API_KEY", undefined);
    vi.stubEnv("ANTHROPIC_API_KEY", undefined);
    vi.stubEnv("OPENAI_API_KEY", undefined);
    expect(() => requireProviderAvailable("fast")).toThrowError(expect.objectContaining({ code: "missing_key" }));
    expect(() => requireProviderAvailable("opus")).toThrowError(expect.objectContaining({ code: "missing_key" }));
    expect(() => requireProviderAvailable("gpt-5")).toThrowError(expect.objectContaining({ code: "missing_key" }));
  });

  it("names the specific env var for each provider", () => {
    vi.stubEnv("USE_MOCK", "false");
    vi.stubEnv("DEEPSEEK_API_KEY", undefined);
    vi.stubEnv("ANTHROPIC_API_KEY", undefined);
    vi.stubEnv("OPENAI_API_KEY", undefined);
    expect(() => requireProviderAvailable("fast")).toThrowError(expect.objectContaining({ message: expect.stringContaining("DEEPSEEK_API_KEY") }));
    expect(() => requireProviderAvailable("opus")).toThrowError(expect.objectContaining({ message: expect.stringContaining("ANTHROPIC_API_KEY") }));
    expect(() => requireProviderAvailable("gpt-5")).toThrowError(expect.objectContaining({ message: expect.stringContaining("OPENAI_API_KEY") }));
  });

  it("does not throw when the model's provider is configured", () => {
    vi.stubEnv("USE_MOCK", "false");
    vi.stubEnv("DEEPSEEK_API_KEY", "deepseek-key");
    vi.stubEnv("ANTHROPIC_API_KEY", undefined);
    vi.stubEnv("OPENAI_API_KEY", undefined);
    expect(() => requireProviderAvailable("fast")).not.toThrow();
    expect(() => requireProviderAvailable("thinking")).not.toThrow();
    expect(() => requireProviderAvailable("opus")).toThrowError(expect.objectContaining({ code: "missing_key" }));
  });

  it("does not throw in mock mode regardless of keys", () => {
    vi.stubEnv("USE_MOCK", "true");
    vi.stubEnv("DEEPSEEK_API_KEY", undefined);
    vi.stubEnv("ANTHROPIC_API_KEY", undefined);
    vi.stubEnv("OPENAI_API_KEY", undefined);
    expect(() => requireProviderAvailable("fast")).not.toThrow();
    expect(() => requireProviderAvailable("opus")).not.toThrow();
    expect(() => requireProviderAvailable("gpt-5")).not.toThrow();
  });

  it("routes streamChat to the mock provider in mock mode", async () => {
    vi.stubEnv("USE_MOCK", "true");
    vi.stubEnv("DEEPSEEK_API_KEY", undefined);
    const chunks: unknown[] = [];
    for await (const chunk of streamChat({ messages: [{ role: "user", content: "hi" }], modelKey: "fast" })) chunks.push(chunk);
    expect(chunks.length).toBeGreaterThan(0);
  });
});

describe("Anthropic HTTP adapter", () => {
  let transport: ReturnType<typeof vi.fn<typeof fetch>>;
  const messages = [{ role: "system" as const, content: "A stable prefix." }, { role: "user" as const, content: "Reply with OK." }];

  async function collect(modelKey: "opus" | "sonnet" | "haiku" = "opus") {
    const chunks: ProviderChunk[] = [];
    for await (const chunk of streamChat({ messages, modelKey })) chunks.push(chunk);
    return chunks;
  }

  beforeEach(() => {
    vi.stubEnv("USE_MOCK", "false");
    vi.stubEnv("ANTHROPIC_API_KEY", "fixture-only-not-a-real-key");
    transport = vi.fn<typeof fetch>().mockRejectedValue(new Error("No HTTP fixture installed"));
    vi.stubGlobal("fetch", transport);
  });

  it("does not route saved Opus selections to the retired 4.1 model family", () => {
    expect(modelFor("opus")).toMatchObject({ key: "opus", provider: "anthropic" });
    expect(modelFor("opus").id).not.toMatch(/-4-1(?:-|$)/);
  });

  it.each(["opus", "sonnet", "haiku"] as const)("streams %s through Messages with compatible settings and measured usage", async (key) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const parts = [
      { type: "message_start", message: { id: "fixture", type: "message", role: "assistant", model: modelFor(key).id, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ];
    transport.mockResolvedValue(new Response(parts.map((part) => `event: ${part.type}\ndata: ${JSON.stringify(part)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } }));

    expect(await collect(key)).toEqual([{ type: "text", text: "OK" }, { type: "usage", inputTokens: 12, outputTokens: 1 }]);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0][0]).toBe("https://api.anthropic.com/v1/messages");
    expect(new Headers(transport.mock.calls[0][1]?.headers).get("x-api-key")).toBe("fixture-only-not-a-real-key");
    const body = JSON.parse(transport.mock.calls[0][1]?.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: modelFor(key).id,
      stream: true,
      system: [{ type: "text", text: messages[0].content }],
      messages: [{ role: "user", content: [{ type: "text", text: messages[1].content }] }],
    });
    if (key === "opus") {
      expect(body).toMatchObject({ max_tokens: 32_000 });
      expect(body).not.toHaveProperty("temperature");
      expect(body).not.toHaveProperty("top_p");
      expect(body).not.toHaveProperty("top_k");
    } else {
      expect(body.temperature).toBe(0);
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it("reports an unavailable Opus model without disguising it as a network failure or exposing provider details", async () => {
    transport.mockResolvedValue(Response.json({ type: "error", error: { type: "not_found_error", message: "Private provider details" } }, { status: 404 }));
    const error = await collect().then(() => null, (error: unknown) => error);
    const readable = readableError(error);
    expect(readable).toMatchObject({ status: 404, code: "model_unavailable" });
    expect(readable.message).toContain("Choose another model");
    expect(readable.message).not.toContain("Private provider details");
    expect(transport).toHaveBeenCalledTimes(1);
  });
});
