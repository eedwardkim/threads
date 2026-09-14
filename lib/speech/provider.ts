import { AppError } from "../errors";
import { mockEnabled } from "../provider";

export type SpeechProviderId = "openai" | "elevenlabs" | "mock";

export interface SpeechVoice {
  id: string;
  label: string;
}

export interface SpeechRequest {
  text: string;
  voice: string;
  /** Neighbouring chunk text lets providers that support it keep prosody continuous across chunks. */
  previousText?: string;
  nextText?: string;
  signal?: AbortSignal;
}

export interface SpeechAudio {
  body: ReadableStream<Uint8Array>;
  contentType: string;
}

export interface SpeechProvider {
  id: SpeechProviderId;
  defaultVoice: string;
  voices(): Promise<SpeechVoice[]>;
  synthesize(request: SpeechRequest): Promise<SpeechAudio>;
}

/**
 * Delivery guidance for instruction-following TTS models. This is what makes read-aloud sound like a
 * patient tutor rather than a newsreader: even pacing, real pauses at block boundaries, and careful
 * numbers. The text itself is already speech-ready (see ./speakable.ts), so the model is told not to
 * improvise around it.
 */
export const READ_ALOUD_INSTRUCTIONS = [
  "You are reading a written explanation aloud to one attentive listener, like a calm, warm tutor.",
  "Speak clearly at a natural, unhurried conversational pace with steady energy; never rush.",
  "Pause briefly at commas, a little longer at sentence ends, and longer still between paragraphs.",
  "Read numbers, equations, symbols, code names and technical terms slowly and precisely, exactly as written.",
  "Do not add, skip, summarize or comment on any words. Do not perform accents or exaggerated emotion.",
].join(" ");

const OPENAI_VOICES: SpeechVoice[] = [
  { id: "marin", label: "Marin" },
  { id: "cedar", label: "Cedar" },
  { id: "coral", label: "Coral" },
  { id: "sage", label: "Sage" },
  { id: "ash", label: "Ash" },
  { id: "ballad", label: "Ballad" },
  { id: "nova", label: "Nova" },
  { id: "onyx", label: "Onyx" },
  { id: "verse", label: "Verse" },
];

function providerFailure(status: number, provider: string): AppError {
  if (status === 401 || status === 403) return new AppError(`The ${provider} speech key was rejected. Check the server configuration.`, 502, "speech_key");
  if (status === 429) return new AppError("The voice service is busy. Try again in a moment.", 429, "rate_limit");
  if (status >= 500) return new AppError("The voice service is unavailable right now. Try again shortly.", 502, "speech_unavailable");
  return new AppError("This passage could not be turned into speech.", 502, "speech_failed");
}

async function fetchAudio(url: string, init: RequestInit, provider: string): Promise<SpeechAudio> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new AppError("The voice service could not be reached.", 502, "speech_unavailable");
  }
  if (!response.ok || !response.body) throw providerFailure(response.status, provider);
  return { body: response.body, contentType: response.headers.get("content-type") ?? "audio/mpeg" };
}

export function createOpenAISpeechProvider(apiKey: string, model = "gpt-4o-mini-tts"): SpeechProvider {
  return {
    id: "openai",
    defaultVoice: "marin",
    voices: async () => OPENAI_VOICES,
    synthesize: ({ text, voice, signal }) => fetchAudio("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, voice, input: text, instructions: READ_ALOUD_INSTRUCTIONS, response_format: "mp3" }),
      signal,
    }, "OpenAI"),
  };
}

interface ElevenLabsVoiceList { voices?: { voice_id: string; name: string; category?: string }[] }

export function createElevenLabsSpeechProvider(apiKey: string, model = "eleven_multilingual_v2", defaultVoice = "JBFqnCBsd6RMkjVDRZzb"): SpeechProvider {
  let cached: { at: number; voices: SpeechVoice[] } | null = null;
  return {
    id: "elevenlabs",
    defaultVoice,
    async voices() {
      if (cached && Date.now() - cached.at < 10 * 60_000) return cached.voices;
      const response = await fetch("https://api.elevenlabs.io/v1/voices", { headers: { "xi-api-key": apiKey } });
      if (!response.ok) throw providerFailure(response.status, "ElevenLabs");
      const list = (await response.json()) as ElevenLabsVoiceList;
      const voices = (list.voices ?? []).map((voice) => ({ id: voice.voice_id, label: voice.name }));
      cached = { at: Date.now(), voices };
      return voices;
    },
    synthesize: ({ text, voice, previousText, nextText, signal }) => fetchAudio(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_128`, {
      method: "POST",
      headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ text, model_id: model, previous_text: previousText, next_text: nextText }),
      signal,
    }, "ElevenLabs"),
  };
}

/** Deterministic tone whose length tracks the text, so the player can be exercised without a provider. */
export function mockSpeechAudio(text: string): Uint8Array {
  const sampleRate = 8_000;
  const seconds = Math.min(2, Math.max(0.2, text.length * 0.004));
  const samples = Math.round(sampleRate * seconds);
  const buffer = new ArrayBuffer(44 + samples * 2);
  const view = new DataView(buffer);
  const ascii = (offset: number, value: string) => { for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i)); };
  ascii(0, "RIFF"); view.setUint32(4, 36 + samples * 2, true); ascii(8, "WAVE");
  ascii(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  ascii(36, "data"); view.setUint32(40, samples * 2, true);
  for (let i = 0; i < samples; i += 1) view.setInt16(44 + i * 2, Math.round(Math.sin((i / sampleRate) * 2 * Math.PI * 440) * 6_000), true);
  return new Uint8Array(buffer);
}

export const mockSpeechProvider: SpeechProvider = {
  id: "mock",
  defaultVoice: "mock",
  voices: async () => [{ id: "mock", label: "Mock voice" }],
  synthesize: async ({ text }) => ({
    body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(mockSpeechAudio(text)); controller.close(); } }),
    contentType: "audio/wav",
  }),
};

/**
 * `THREADS_SPEECH_PROVIDER` (openai | elevenlabs | mock) when set, otherwise ElevenLabs when its key is
 * configured, then OpenAI. The mock voice is used automatically only under `USE_MOCK=true` with no key.
 */
export function speechProvider(env: NodeJS.ProcessEnv = process.env): SpeechProvider | null {
  const requested = env.THREADS_SPEECH_PROVIDER?.trim();
  const openaiKey = env.OPENAI_API_KEY?.trim();
  const elevenKey = env.ELEVENLABS_API_KEY?.trim();
  const openai = () => openaiKey ? createOpenAISpeechProvider(openaiKey, env.THREADS_OPENAI_TTS_MODEL?.trim() || undefined) : null;
  const eleven = () => elevenKey ? createElevenLabsSpeechProvider(elevenKey, env.THREADS_ELEVENLABS_MODEL?.trim() || undefined, env.THREADS_ELEVENLABS_VOICE?.trim() || undefined) : null;
  if (requested === "mock") return mockEnabled(env) ? mockSpeechProvider : null;
  if (requested === "openai") return openai();
  if (requested === "elevenlabs") return eleven();
  if (requested) throw new AppError("THREADS_SPEECH_PROVIDER must be one of openai, elevenlabs, mock.", 503, "invalid_config");
  return eleven() ?? openai() ?? (mockEnabled(env) ? mockSpeechProvider : null);
}
