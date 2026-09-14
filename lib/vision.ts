import { AppError } from "./errors";
import { MODELS, isModelKey, modelFor, type ModelKey } from "./models";
import type { AttachmentFile } from "./db/repository";
import type { Attachment, PromptMessage, ProviderStatus } from "./types";

/**
 * Images reach a model in one of two forms:
 * - native image parts, for vision-capable models on the most recent image-bearing turn;
 * - a cached digest (verbatim text + structured description), for text-only models and for older
 *   turns, so a conversation never re-sends megabytes of pixels or loses what the image said.
 * The digest is produced once per image by a vision model and stored on the attachment.
 */

/** A turn keeps its native images while it is within this many user turns of the end. */
export const NATIVE_RECENT_TURNS = 4;
export const DIGEST_VERSION = 1;

export const DIGEST_SYSTEM_PROMPT = `You convert one image into a faithful written record for an assistant that cannot see it. Nothing may be lost: a reader must be able to answer detailed questions about the image from your text alone.

Write in this exact structure, in the language of the image's text (default English):

Type: <photo | screenshot | document | diagram | chart | table | handwriting | code | UI | artwork | other>, one clause on the subject.
Summary: two or three sentences covering what the image shows and why someone might share it.
Text: every piece of legible text transcribed exactly, top to bottom and left to right, preserving line breaks. Code goes in fenced code blocks with the language. Math goes in LaTeX. Tables become Markdown tables. Write "none" if there is no text.
Details: a bullet list of everything a careful observer would note: layout and regions (top-left, center, ...), objects and people (appearance, pose, count), colors, numbers and units, axes, legends and every data point or trend you can read from charts, arrows and relationships in diagrams, UI state (selected items, errors, disabled controls, cursor position), timestamps, logos, quality issues (blur, crop, glare).
Uncertain: anything partially legible or ambiguous, with your best reading marked as such. Write "none" if everything was clear.

Be exhaustive rather than brief, but never invent content. Do not add commentary, advice or a conclusion.`;

const DIGEST_PREFERENCE: readonly ModelKey[] = ["gpt-5.4-mini", "haiku", "fast"];

/** The vision model used to write digests: `THREADS_VISION_MODEL` when configured, else the cheapest configured one. */
export function digestModelKey(status: ProviderStatus, env: NodeJS.ProcessEnv = process.env): ModelKey | null {
  const requested = env.THREADS_VISION_MODEL?.trim();
  if (requested) {
    if (!isModelKey(requested) || !modelFor(requested).vision) throw new AppError("THREADS_VISION_MODEL must be a vision-capable model key from lib/models.ts.", 503, "invalid_config");
    return status.mock || status[modelFor(requested).provider] ? requested : null;
  }
  if (status.mock) return DIGEST_PREFERENCE[0];
  return DIGEST_PREFERENCE.find((key) => status[modelFor(key).provider])
    ?? MODELS.find((model) => model.vision && !("legacy" in model && model.legacy) && status[model.provider])?.key ?? null;
}

function dimensions(attachment: Attachment): string {
  return `${attachment.width}×${attachment.height}`;
}

/**
 * The text the model reads for a user turn with images. In `native` mode the images follow as
 * parts, so the text only names them; in `digest` mode each image's record is inlined.
 */
export function attachmentText(content: string, attachments: Attachment[], mode: "native" | "digest"): string {
  if (attachments.length === 0) return content;
  const blocks = attachments.map((attachment, index) => {
    const label = `[Image ${index + 1}: ${attachment.name}, ${dimensions(attachment)}]`;
    if (mode === "native") return label;
    return `${label}\n${attachment.digest?.trim() || "(This image could not be described.)"}\n[End of image ${index + 1}]`;
  });
  const intro = mode === "native"
    ? `The user attached ${attachments.length === 1 ? "an image" : `${attachments.length} images`} (shown after this text):`
    : `The user attached ${attachments.length === 1 ? "an image" : `${attachments.length} images`}. You cannot see pixels; each image is given as a complete written record. Treat it as if you had looked at the image, and do not mention the record itself:`;
  return [content.trim(), intro, ...blocks].filter(Boolean).join("\n\n");
}

/** Deterministic stand-in used with `USE_MOCK=true`; keeps local development and tests offline. */
export function mockDigest(attachment: Attachment): string {
  return [
    `Type: other, mock description of "${attachment.name}".`,
    `Summary: A ${dimensions(attachment)} ${attachment.mediaType.slice("image/".length).toUpperCase()} image supplied in mock mode; no model looked at it.`,
    "Text: none",
    `Details:\n- Dimensions ${dimensions(attachment)}, ${attachment.byteSize} bytes.\n- Mock mode records metadata only.`,
    "Uncertain: none",
  ].join("\n");
}

export interface DigestWriter {
  describe(file: AttachmentFile, signal?: AbortSignal): Promise<{ digest: string; model: string }>;
}

export interface ResolveInput {
  prompt: PromptMessage[];
  modelKey: ModelKey;
  status: ProviderStatus;
  load(ids: string[]): Promise<AttachmentFile[]>;
  save(id: string, digest: string, model: string): Promise<void>;
  writer: DigestWriter;
  signal?: AbortSignal;
  /** Always use digests, e.g. for text that will be stored or compressed rather than answered. */
  forceDigest?: boolean;
}

/**
 * Fills in `images` (native parts) or `digest` text for every user turn that carries attachments.
 * Mutates the freshly assembled prompt in place; nothing here touches persisted message content.
 */
export async function resolvePromptAttachments({ prompt, modelKey, status, load, save, writer, signal, forceDigest = false }: ResolveInput): Promise<void> {
  const withImages = prompt.filter((message) => message.role === "user" && message.attachments?.length);
  if (withImages.length === 0) return;
  const userTurns = prompt.filter((message) => message.role === "user");
  const native = new Set<PromptMessage>();
  if (!forceDigest && modelFor(modelKey).vision && !status.mock) {
    const latest = withImages[withImages.length - 1];
    if (userTurns.length - userTurns.lastIndexOf(latest) <= NATIVE_RECENT_TURNS) native.add(latest);
  }
  const needBytes = new Set<string>();
  const needDigest: Attachment[] = [];
  for (const message of withImages) {
    for (const attachment of message.attachments!) {
      if (native.has(message)) needBytes.add(attachment.id);
      else if (!attachment.digest) {
        needDigest.push(attachment);
        needBytes.add(attachment.id);
      }
    }
  }
  const files = new Map((await load([...needBytes])).map((file) => [file.id, file]));
  const latestIds = new Set(withImages[withImages.length - 1].attachments!.map((attachment) => attachment.id));
  for (const attachment of needDigest) {
    signal?.throwIfAborted();
    const file = files.get(attachment.id);
    if (!file) throw new AppError("An attached image is missing. Remove it and try again.", 404, "attachment_not_found");
    try {
      const { digest, model } = await writer.describe(file, signal);
      await save(attachment.id, digest, model);
      attachment.digest = digest;
      file.digest = digest;
    } catch (error) {
      // The image the user just sent must be readable; an older one degrades to "not described".
      if (latestIds.has(attachment.id) || signal?.aborted) throw error;
      console.warn("[vision] digest failed", { id: attachment.id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  for (const message of native) {
    message.images = message.attachments!.map((attachment) => {
      const file = files.get(attachment.id);
      if (!file) throw new AppError("An attached image is missing. Remove it and try again.", 404, "attachment_not_found");
      return { data: file.data, mediaType: file.mediaType };
    });
  }
}
