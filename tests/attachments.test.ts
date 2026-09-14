import { describe, expect, it } from "vitest";
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_EDGE, safeAttachmentName, sniffImage, validateImage } from "../lib/attachments/image";
import { sdkPrompt } from "../lib/providers/stream";
import type { Attachment, PromptMessage, ProviderStatus } from "../lib/types";
import { attachmentText, digestModelKey, mockDigest, NATIVE_RECENT_TURNS, resolvePromptAttachments, type DigestWriter } from "../lib/vision";
import type { AttachmentFile } from "../lib/db/repository";
import { gif, jpeg, png, webpLossless } from "./image-fixtures";

describe("image sniffing", () => {
  it("reads format and dimensions from bytes, never from a declared type", () => {
    expect(sniffImage(png(640, 480))).toEqual({ mediaType: "image/png", width: 640, height: 480 });
    expect(sniffImage(gif(12, 34))).toEqual({ mediaType: "image/gif", width: 12, height: 34 });
    expect(sniffImage(jpeg(1024, 768))).toEqual({ mediaType: "image/jpeg", width: 1024, height: 768 });
    expect(sniffImage(webpLossless(300, 200))).toEqual({ mediaType: "image/webp", width: 300, height: 200 });
  });

  it("rejects non-images, zero dimensions and truncated headers", () => {
    expect(sniffImage(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
    expect(sniffImage(new TextEncoder().encode("%PDF-1.7 not an image"))).toBeNull();
    expect(sniffImage(png(0, 10))).toBeNull();
    expect(sniffImage(png(10, 10).subarray(0, 20))).toBeNull();
    expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0]))).toBeNull();
  });

  it("enforces server-side size and edge limits", () => {
    expect(() => validateImage(new Uint8Array())).toThrow(/empty/);
    expect(() => validateImage(png(10, 10, MAX_ATTACHMENT_BYTES + 1))).toThrow(/under 6 MB/);
    expect(() => validateImage(png(MAX_ATTACHMENT_EDGE + 1, 10))).toThrow(/8192 pixels/);
    expect(() => validateImage(new TextEncoder().encode("hello world!"))).toThrow(/Only PNG/);
    expect(validateImage(png(MAX_ATTACHMENT_EDGE, 1))).toEqual({ mediaType: "image/png", width: 8192, height: 1 });
  });

  it("sanitizes file names and falls back to the format", () => {
    expect(safeAttachmentName("  shot\u0000.png\n", "image/png")).toBe("shot.png");
    expect(safeAttachmentName("", "image/jpeg")).toBe("image.jpg");
    expect(safeAttachmentName("   ", "image/webp")).toBe("image.webp");
    expect(safeAttachmentName("x".repeat(500), "image/png")).toHaveLength(120);
  });
});

const status = (overrides: Partial<ProviderStatus> = {}): ProviderStatus => ({ mock: false, deepseek: false, anthropic: false, openai: false, ...overrides });

describe("digest model selection", () => {
  it("prefers the cheap vision models of configured providers and honours THREADS_VISION_MODEL", () => {
    expect(digestModelKey(status(), { NODE_ENV: "test" })).toBeNull();
    expect(digestModelKey(status({ openai: true }), { NODE_ENV: "test" })).toBe("gpt-5.4-mini");
    expect(digestModelKey(status({ anthropic: true }), { NODE_ENV: "test" })).toBe("haiku");
    expect(digestModelKey(status({ deepseek: true }), { NODE_ENV: "test" })).toBe("fast");
    expect(digestModelKey(status({ openai: true, anthropic: true }), { NODE_ENV: "test", THREADS_VISION_MODEL: "sonnet-5" })).toBe("sonnet-5");
    expect(digestModelKey(status({ openai: true }), { NODE_ENV: "test", THREADS_VISION_MODEL: "sonnet-5" })).toBeNull();
    expect(() => digestModelKey(status({ openai: true }), { NODE_ENV: "test", THREADS_VISION_MODEL: "deepseek-pro" })).toThrow(/vision-capable/);
    expect(digestModelKey(status({ mock: true }), { NODE_ENV: "test" })).toBe("gpt-5.4-mini");
  });
});

function attachment(id: string, digest: string | null = null): Attachment {
  return { id, name: `${id}.png`, mediaType: "image/png", width: 800, height: 600, byteSize: 1234, digest };
}

function file(meta: Attachment): AttachmentFile {
  return { ...meta, chatId: "chat", messageId: "message", data: png(meta.width, meta.height) };
}

describe("attachment prompt text", () => {
  it("names images for native turns and inlines digests for text-only turns", () => {
    const native = attachmentText("What is this?", [attachment("a")], "native");
    expect(native).toContain("What is this?");
    expect(native).toContain("a.png");
    expect(native).not.toContain("could not be described");
    const digest = attachmentText("What is this?", [attachment("a", "Type: chart\nSummary: sales by quarter"), attachment("b")], "digest");
    expect(digest).toContain("sales by quarter");
    expect(digest).toContain("could not be described");
    expect(digest).toContain("What is this?");
  });

  it("mock digests record metadata only", () => {
    const digest = mockDigest(attachment("a"));
    expect(digest).toContain("800×600");
    expect(digest).toMatch(/mock/i);
  });
});

function harness(files: AttachmentFile[], describeImpl?: DigestWriter["describe"]) {
  const saved: Array<[string, string, string]> = [];
  const loaded: string[][] = [];
  const described: string[] = [];
  const writer: DigestWriter = {
    describe: describeImpl ?? (async (image) => {
      described.push(image.id);
      return { digest: `digest of ${image.id}`, model: "vision-test" };
    }),
  };
  const deps = {
    status: status({ openai: true }),
    writer,
    load: async (ids: string[]) => { loaded.push(ids); return files.filter((entry) => ids.includes(entry.id)); },
    save: async (id: string, digest: string, model: string) => { saved.push([id, digest, model]); },
  };
  return { deps, saved, loaded, described };
}

describe("resolvePromptAttachments", () => {
  it("leaves prompts without attachments untouched and loads nothing", async () => {
    const prompt: PromptMessage[] = [{ role: "system", content: "s" }, { role: "user", content: "hi" }];
    const { deps, loaded } = harness([]);
    await resolvePromptAttachments({ prompt, modelKey: "sonnet-5", ...deps });
    expect(prompt).toEqual([{ role: "system", content: "s" }, { role: "user", content: "hi" }]);
    expect(loaded).toEqual([]);
  });

  it("gives a vision model native image parts for the latest turn and digests for older ones", async () => {
    const old = attachment("old");
    const latest = attachment("new");
    const prompt: PromptMessage[] = [
      { role: "user", content: "first", attachments: [old] },
      { role: "assistant", content: "ok" },
      { role: "user", content: "second", attachments: [latest] },
    ];
    const { deps, saved, described } = harness([file(old), file(latest)]);
    await resolvePromptAttachments({ prompt, modelKey: "sonnet-5", ...deps });
    expect(prompt[2].images).toHaveLength(1);
    expect(prompt[2].images![0].mediaType).toBe("image/png");
    expect(prompt[0].images).toBeUndefined();
    expect(prompt[0].attachments![0].digest).toBe("digest of old");
    expect(described).toEqual(["old"]);
    expect(saved).toEqual([["old", "digest of old", "vision-test"]]);
  });

  it("uses digests everywhere for a text-only model and caches them once", async () => {
    const cached = attachment("cached", "already described");
    const fresh = attachment("fresh");
    const prompt: PromptMessage[] = [{ role: "user", content: "look", attachments: [cached, fresh] }];
    const { deps, saved, described, loaded } = harness([file(fresh)]);
    await resolvePromptAttachments({ prompt, modelKey: "deepseek-pro", ...deps });
    expect(prompt[0].images).toBeUndefined();
    expect(described).toEqual(["fresh"]);
    expect(loaded).toEqual([["fresh"]]);
    expect(saved).toHaveLength(1);
    const rendered = sdkPrompt(prompt).messages[0];
    expect(rendered.content).toContain("already described");
    expect(rendered.content).toContain("digest of fresh");
  });

  it("falls back to digests when the image turn is too old for native parts", async () => {
    const image = attachment("img");
    const prompt: PromptMessage[] = [{ role: "user", content: "see", attachments: [image] }];
    for (let index = 0; index < NATIVE_RECENT_TURNS; index += 1) {
      prompt.push({ role: "assistant", content: "a" }, { role: "user", content: `follow-up ${index}` });
    }
    const { deps, described } = harness([file(image)]);
    await resolvePromptAttachments({ prompt, modelKey: "sonnet-5", ...deps });
    expect(prompt[0].images).toBeUndefined();
    expect(described).toEqual(["img"]);
  });

  it("fails loudly when the just-sent image cannot be described, but degrades for older ones", async () => {
    const old = attachment("old");
    const latest = attachment("new");
    const prompt: PromptMessage[] = [
      { role: "user", content: "first", attachments: [old] },
      { role: "user", content: "second", attachments: [latest] },
    ];
    const { deps } = harness([file(old), file(latest)], async () => { throw new Error("vision down"); });
    await resolvePromptAttachments({ prompt, modelKey: "deepseek-pro", ...deps, load: async (ids) => [file(old), file(latest)].filter((entry) => ids.includes(entry.id)) })
      .then(() => { throw new Error("expected failure"); }, (error: Error) => expect(error.message).toBe("vision down"));
    expect(prompt[0].attachments![0].digest).toBeNull();
  });

  it("reports a missing file instead of silently dropping the image", async () => {
    const prompt: PromptMessage[] = [{ role: "user", content: "see", attachments: [attachment("gone")] }];
    const { deps } = harness([]);
    await expect(resolvePromptAttachments({ prompt, modelKey: "sonnet-5", ...deps })).rejects.toMatchObject({ code: "attachment_not_found" });
  });
});

describe("sdkPrompt with images", () => {
  it("emits multi-part user content only when native image bytes are present", () => {
    const data = png(2, 2);
    const { system, messages } = sdkPrompt([
      { role: "system", content: "sys" },
      { role: "user", content: "plain" },
      { role: "user", content: "with image", attachments: [attachment("a")], images: [{ data, mediaType: "image/png" }] },
      { role: "assistant", content: "reply" },
    ]);
    expect(system).toEqual([{ role: "system", content: "sys" }]);
    expect(messages[0]).toEqual({ role: "user", content: "plain" });
    expect(messages[2]).toEqual({ role: "assistant", content: "reply" });
    const parts = messages[1].content as Array<{ type: string; text?: string; image?: Uint8Array; mediaType?: string }>;
    expect(parts[0].type).toBe("text");
    expect(parts[0].text).toContain("with image");
    expect(parts[1]).toEqual({ type: "image", image: data, mediaType: "image/png" });
  });
});
