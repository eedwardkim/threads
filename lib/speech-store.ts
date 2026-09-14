"use client";

import { useSyncExternalStore } from "react";
import { registerPrivateState } from "./client-state";
import { SPEECH_PIPELINE_VERSION, speechChunks, type SpeechChunk } from "./speech/speakable";
import type { Message } from "./types";

export type SpeechStatus = "idle" | "loading" | "playing" | "paused" | "error";

export interface SpeechSnapshot {
  messageId: string | null;
  status: SpeechStatus;
  chunk: number;
  chunks: readonly SpeechChunk[];
  error: string | null;
  voice: string | null;
  rate: number;
}

export interface SpeechVoiceInfo {
  provider: "openai" | "elevenlabs" | "mock" | null;
  voices: { id: string; label: string }[];
  defaultVoice: string | null;
}

export const SPEECH_RATES = [0.8, 1, 1.25, 1.5, 1.75, 2] as const;
const PREFETCH_AHEAD = 2;
const VOICE_KEY = "threads:speech:voice";
const RATE_KEY = "threads:speech:rate";

function readPreference(key: string): string | null {
  try { return window.localStorage.getItem(key); } catch { return null; }
}

function savePreference(key: string, value: string) {
  try { window.localStorage.setItem(key, value); } catch {}
}

function initialRate(): number {
  const saved = Number(readPreference(RATE_KEY));
  return (SPEECH_RATES as readonly number[]).includes(saved) ? saved : 1;
}

const IDLE: SpeechSnapshot = { messageId: null, status: "idle", chunk: 0, chunks: [], error: null, voice: null, rate: 1 };

interface Prefetch { controller: AbortController; blob: Promise<string | null> }

/**
 * One read-aloud session for the whole app: plays a completed message chunk by chunk through a single
 * `<audio>` element. The chunk the user asked for streams straight from its URL (so `play()` runs inside
 * the click and audio starts as soon as the first bytes arrive); the next chunks are prefetched into
 * blobs so boundaries are seamless. URLs are immutable per (message, chunk, voice, pipeline version).
 */
class SpeechStore {
  private snapshot: SpeechSnapshot = IDLE;
  private listeners = new Set<() => void>();
  private audio: HTMLAudioElement | null = null;
  private prefetched = new Map<number, Prefetch>();
  private generation = 0;
  private info: Promise<SpeechVoiceInfo> | null = null;

  constructor() {
    if (typeof window !== "undefined") {
      this.snapshot = { ...IDLE, voice: readPreference(VOICE_KEY), rate: initialRate() };
      registerPrivateState(() => this.stop());
    }
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getSnapshot = () => this.snapshot;
  getServerSnapshot = () => IDLE;

  private set(patch: Partial<SpeechSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((listener) => listener());
  }

  /** Voice service description, fetched once per page load. */
  voiceInfo(): Promise<SpeechVoiceInfo> {
    this.info ??= fetch("/api/speech", { credentials: "same-origin" })
      .then(async (response) => (response.ok ? response.json() : { provider: null, voices: [], defaultVoice: null }) as Promise<SpeechVoiceInfo>)
      .catch(() => ({ provider: null, voices: [], defaultVoice: null }));
    return this.info;
  }

  isActive(messageId: string): boolean {
    return this.snapshot.messageId === messageId && this.snapshot.status !== "idle";
  }

  /** Starts, pauses or resumes reading `message`; must be called from a user gesture the first time. */
  toggle(message: Message) {
    if (this.snapshot.messageId === message.id) {
      if (this.snapshot.status === "paused") return this.resume();
      if (this.snapshot.status === "playing" || this.snapshot.status === "loading") return this.pause();
    }
    this.reset();
    const chunks = speechChunks(message.content);
    if (!chunks.length) {
      this.set({ messageId: message.id, status: "error", chunks, chunk: 0, error: "There is nothing to read in this message." });
      return;
    }
    this.set({ messageId: message.id, chunks, chunk: 0, error: null });
    this.start(0);
  }

  pause() {
    if (this.snapshot.status !== "playing" && this.snapshot.status !== "loading") return;
    this.audio?.pause();
    this.set({ status: "paused" });
  }

  resume() {
    if (this.snapshot.status !== "paused") return;
    if (this.audio?.src) {
      this.set({ status: "playing" });
      this.audio.play().catch((error: unknown) => this.fail(error));
    } else {
      this.start(this.snapshot.chunk);
    }
  }

  stop() {
    this.reset();
    this.set({ ...IDLE, voice: this.snapshot.voice, rate: this.snapshot.rate });
  }

  seek(index: number) {
    if (this.snapshot.status === "idle" || index < 0 || index >= this.snapshot.chunks.length) return;
    this.start(index);
  }

  next() { this.seek(this.snapshot.chunk + 1); }
  previous() { this.seek(this.snapshot.chunk - 1); }

  setRate(rate: number) {
    if (!(SPEECH_RATES as readonly number[]).includes(rate)) return;
    savePreference(RATE_KEY, String(rate));
    if (this.audio) this.audio.playbackRate = rate;
    this.set({ rate });
  }

  setVoice(voice: string) {
    if (voice === this.snapshot.voice) return;
    savePreference(VOICE_KEY, voice);
    const resume = this.snapshot.status === "playing" || this.snapshot.status === "loading";
    const chunk = this.snapshot.chunk;
    this.abortPrefetches();
    this.set({ voice });
    if (resume) this.start(chunk);
    else if (this.snapshot.status === "paused") { this.audio?.removeAttribute("src"); this.audio?.load(); }
  }

  private element(): HTMLAudioElement {
    if (!this.audio) {
      this.audio = new Audio();
      this.audio.preload = "auto";
      this.audio.addEventListener("ended", () => {
        const next = this.snapshot.chunk + 1;
        if (next < this.snapshot.chunks.length) this.start(next);
        else this.stop();
      });
      this.audio.addEventListener("playing", () => {
        if (this.snapshot.status === "loading") this.set({ status: "playing" });
      });
      this.audio.addEventListener("error", () => {
        if (this.snapshot.status === "playing" || this.snapshot.status === "loading") void this.explainFailure();
      });
    }
    return this.audio;
  }

  private url(index: number): string {
    const params = new URLSearchParams({ message: this.snapshot.messageId ?? "", chunk: String(index), v: String(SPEECH_PIPELINE_VERSION) });
    if (this.snapshot.voice) params.set("voice", this.snapshot.voice);
    return `/api/speech?${params}`;
  }

  private prefetch(index: number): Prefetch {
    const existing = this.prefetched.get(index);
    if (existing) return existing;
    const controller = new AbortController();
    const blob = fetch(this.url(index), { credentials: "same-origin", signal: controller.signal })
      .then(async (response) => (response.ok ? URL.createObjectURL(await response.blob()) : null))
      .catch(() => null);
    const entry = { controller, blob };
    this.prefetched.set(index, entry);
    return entry;
  }

  private start(index: number) {
    const generation = ++this.generation;
    const audio = this.element();
    audio.pause();
    this.set({ chunk: index, status: "loading", error: null });
    const ready = this.prefetched.get(index);
    const begin = (source: string) => {
      if (generation !== this.generation) return;
      audio.src = source;
      audio.playbackRate = this.snapshot.rate;
      audio.play().catch((error: unknown) => { if (generation === this.generation) this.fail(error); });
      for (let ahead = 1; ahead <= PREFETCH_AHEAD; ahead += 1) {
        if (index + ahead < this.snapshot.chunks.length) this.prefetch(index + ahead);
      }
    };
    if (!ready) begin(this.url(index));
    else void ready.blob.then((blobUrl) => begin(blobUrl ?? this.url(index)));
  }

  /** A media element error carries no body, so ask the endpoint what went wrong. */
  private async explainFailure() {
    const generation = this.generation;
    let message = "Audio playback failed.";
    try {
      const response = await fetch(this.url(this.snapshot.chunk), { credentials: "same-origin" });
      const body = await response.json().catch(() => null) as { error?: string } | null;
      if (body?.error) message = body.error;
    } catch {}
    if (generation === this.generation) this.fail(new Error(message));
  }

  private fail(error: unknown) {
    if (error instanceof Error && error.name === "AbortError") return;
    this.audio?.pause();
    this.set({ status: "error", error: error instanceof Error && error.message ? error.message : "Read aloud stopped unexpectedly." });
  }

  private abortPrefetches() {
    this.generation += 1;
    for (const { controller, blob } of this.prefetched.values()) {
      controller.abort();
      void blob.then((url) => { if (url) URL.revokeObjectURL(url); });
    }
    this.prefetched.clear();
  }

  private reset() {
    this.abortPrefetches();
    if (this.audio) {
      this.audio.pause();
      this.audio.removeAttribute("src");
      this.audio.load();
    }
  }
}

export const speechStore = new SpeechStore();

export function useSpeech(): SpeechSnapshot {
  return useSyncExternalStore(speechStore.subscribe, speechStore.getSnapshot, speechStore.getServerSnapshot);
}
