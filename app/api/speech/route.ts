import { z } from "zod";
import { apiError, json, withApiUser } from "@/lib/api";
import { AppError } from "@/lib/errors";
import { speechProvider } from "@/lib/speech/provider";
import { SPEECH_PIPELINE_VERSION, speechChunks } from "@/lib/speech/speakable";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const QUERY = z.object({
  message: z.string().min(1).max(100),
  chunk: z.coerce.number().int().min(0).max(10_000),
  voice: z.string().min(1).max(100).optional(),
  v: z.coerce.number().int().optional(),
});

/**
 * `GET /api/speech` describes the configured voice service; `GET /api/speech?message=…&chunk=n`
 * streams the audio for one chunk of a completed message. Chunking is deterministic
 * (`lib/speech/speakable.ts`), so the client computes the same chunk list locally and the response is
 * immutable for a given message, chunk, voice and pipeline version.
 */
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const provider = speechProvider();
    if (!url.searchParams.has("message")) {
      if (!provider) return json({ provider: null, voices: [], defaultVoice: null });
      return json({ provider: provider.id, voices: await provider.voices(), defaultVoice: provider.defaultVoice });
    }
    const query = QUERY.parse(Object.fromEntries(url.searchParams));
    const { repository } = await withApiUser();
    if (!provider) throw new AppError("Read aloud is not configured. Add OPENAI_API_KEY or ELEVENLABS_API_KEY on the server.", 503, "speech_unconfigured");
    const message = await repository.getMessage(query.message);
    if (!message) throw new AppError("This message no longer exists.", 404, "not_found");
    if (!message.complete) throw new AppError("Wait for the response to finish before listening.", 409, "incomplete");
    if (query.v !== undefined && query.v !== SPEECH_PIPELINE_VERSION) throw new AppError("Reload the page to use the latest voice pipeline.", 409, "stale_client");
    const chunks = speechChunks(message.content);
    const chunk = chunks[query.chunk];
    if (!chunk) throw new AppError("There is nothing to read here.", 404, "no_speech");
    const voices = await provider.voices();
    const voice = voices.some((candidate) => candidate.id === query.voice) ? query.voice! : provider.defaultVoice;
    const audio = await provider.synthesize({
      text: chunk.text,
      voice,
      previousText: chunks[query.chunk - 1]?.text,
      nextText: chunks[query.chunk + 1]?.text,
      signal: request.signal,
    });
    return new Response(audio.body, {
      headers: {
        "Content-Type": audio.contentType,
        "Cache-Control": "private, max-age=31536000, immutable",
        "X-Speech-Chunks": String(chunks.length),
        "X-Speech-Voice": voice,
      },
    });
  } catch (error) { return apiError(error); }
}
