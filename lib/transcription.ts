import { z } from "zod";
import { AppError } from "./errors";
import { mockEnabled } from "./provider";
import { MAX_DICTATION_BYTES } from "./dictation";
import { TRANSCRIPTION_MODELS } from "./models";

export const TRANSCRIPTION_OPTIONS = z.object({
  context: z.string().max(500).default(""),
  language: z.string().regex(/^[a-z]{2,3}$/).optional(),
  terms: z.string().max(500).default(""),
});
export type TranscriptionOptions = z.infer<typeof TRANSCRIPTION_OPTIONS>;
export type TranscriptionProvider = "openai" | "elevenlabs" | "mock";

export function transcriptionProvider(env = process.env): TranscriptionProvider | null {
  const selected = env.THREADS_TRANSCRIPTION_PROVIDER?.trim();
  if (selected && selected !== "openai" && selected !== "elevenlabs") throw new AppError("Invalid transcription provider configuration.", 503, "invalid_config");
  if (selected === "openai") return env.OPENAI_API_KEY?.trim() ? selected : null;
  if (selected === "elevenlabs") return env.ELEVENLABS_API_KEY?.trim() ? selected : null;
  if (env.OPENAI_API_KEY?.trim()) return "openai";
  if (env.ELEVENLABS_API_KEY?.trim()) return "elevenlabs";
  return mockEnabled(env) ? "mock" : null;
}

export async function readDictation(request: Request): Promise<Blob> {
  const mediaType = request.headers.get("content-type")?.split(";")[0];
  if (mediaType !== "audio/webm" && mediaType !== "audio/mp4") throw new AppError("Record audio in WebM or MP4 format.", 415, "audio_format");
  if (Number(request.headers.get("content-length")) > MAX_DICTATION_BYTES) throw new AppError("Recording is too large. Record a shorter passage.", 413, "too_large");
  const reader = request.body?.getReader();
  if (!reader) throw new AppError("No audio was recorded.", 400, "empty_audio");
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_DICTATION_BYTES) {
        await reader.cancel();
        throw new AppError("Recording is too large. Record a shorter passage.", 413, "too_large");
      }
      chunks.push(new Uint8Array(value));
    }
  } finally { reader.releaseLock(); }
  if (size < 32) throw new AppError("No audio was recorded. Try a longer recording.", 400, "empty_audio");
  const audio = new Blob(chunks, { type: mediaType });
  const header = new Uint8Array(await audio.slice(0, 12).arrayBuffer());
  const valid = mediaType === "audio/webm"
    ? header[0] === 0x1a && header[1] === 0x45 && header[2] === 0xdf && header[3] === 0xa3
    : String.fromCharCode(...header.slice(4, 8)) === "ftyp";
  if (!valid) throw new AppError("The audio recording could not be read.", 400, "invalid_audio");
  return audio;
}

export async function transcribe(audio: Blob, options: TranscriptionOptions, signal: AbortSignal) {
  const provider = transcriptionProvider();
  if (!provider) throw new AppError("Dictation needs OPENAI_API_KEY or ELEVENLABS_API_KEY on the server.", 503, "transcription_unconfigured");
  if (provider === "mock") return { text: "This is a mock transcript for testing dictation.", provider };
  const form = new FormData();
  form.set("file", audio, audio.type === "audio/mp4" ? "dictation.mp4" : "dictation.webm");
  const terms = options.terms.split(",").map((term) => term.replace(/[<>\r\n]/g, " ").trim()).filter(Boolean).slice(0, 30);
  const model = process.env.THREADS_TRANSCRIPTION_MODEL?.trim() || TRANSCRIPTION_MODELS[provider];
  if (provider === "openai") {
    form.set("model", model);
    form.set("response_format", "json");
    const modern = model === TRANSCRIPTION_MODELS.openai;
    const context = modern ? options.context : [options.context, terms.join(", ")].filter(Boolean).join("\n");
    if (context) form.set("prompt", context);
    if (modern) for (const term of terms) form.append("keywords[]", term);
    if (options.language) form.set(modern ? "languages[]" : "language", options.language);
  } else {
    form.set("model_id", model);
    form.set("tag_audio_events", "false");
    form.set("diarize", "false");
    if (options.language) form.set("language_code", options.language);
    for (const term of terms) {
      const cleaned = term.replace(/[{}[\]\\]/g, " ").split(/\s+/).slice(0, 5).join(" ").slice(0, 49).trim();
      if (cleaned) form.append("keyterms", cleaned);
    }
  }
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(45_000)]);
  let response: Response;
  try {
    response = await fetch(provider === "openai" ? "https://api.openai.com/v1/audio/transcriptions" : "https://api.elevenlabs.io/v1/speech-to-text", {
      method: "POST", body: form, signal: bounded,
      headers: provider === "openai" ? { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` } : { "xi-api-key": process.env.ELEVENLABS_API_KEY! },
    });
  } catch {
    if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
    throw new AppError(bounded.aborted ? "Transcription timed out. Retry your recording." : "The transcription service could not be reached. Retry your recording.", 502, "transcription_unavailable");
  }
  if (!response.ok) throw new AppError(response.status === 429 ? "The transcription service is busy. Retry shortly." : "Transcription failed. Check the server's speech provider configuration or retry.", response.status === 429 ? 429 : 502, "transcription_failed");
  const result = z.object({ text: z.string().max(100_000) }).safeParse(await response.json());
  if (!result.success) throw new AppError("The transcription service returned an invalid result.", 502, "transcription_failed");
  if (!result.data.text.trim()) throw new AppError("No speech was detected. Try again closer to the microphone.", 422, "no_speech");
  return { text: result.data.text.trim(), provider };
}
