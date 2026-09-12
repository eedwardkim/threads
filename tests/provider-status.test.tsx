import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderBanner } from "../components/provider-banner";
import { getProviderStatus, requireProviderAvailable, streamChat } from "../lib/provider";

afterEach(() => vi.unstubAllEnvs());

describe("server-only provider status", () => {
  it("defaults to a working mock without any environment variable", () => {
    vi.stubEnv("USE_MOCK", undefined);
    vi.stubEnv("DEEPSEEK_API_KEY", undefined);
    vi.stubEnv("ANTHROPIC_API_KEY", undefined);
    vi.stubEnv("OPENAI_API_KEY", undefined);
    expect(getProviderStatus()).toEqual({ mock: true, deepseek: false, anthropic: false, openai: false });
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
    vi.stubEnv("USE_MOCK", undefined);
    vi.stubEnv("DEEPSEEK_API_KEY", undefined);
    vi.stubEnv("ANTHROPIC_API_KEY", undefined);
    vi.stubEnv("OPENAI_API_KEY", undefined);
    expect(() => requireProviderAvailable("fast")).not.toThrow();
    expect(() => requireProviderAvailable("opus")).not.toThrow();
    expect(() => requireProviderAvailable("gpt-5")).not.toThrow();
  });

  it("routes streamChat to the mock provider in mock mode", async () => {
    vi.stubEnv("USE_MOCK", undefined);
    vi.stubEnv("DEEPSEEK_API_KEY", undefined);
    const chunks: unknown[] = [];
    for await (const chunk of streamChat({ messages: [{ role: "user", content: "hi" }], modelKey: "fast" })) chunks.push(chunk);
    expect(chunks.length).toBeGreaterThan(0);
  });
});
