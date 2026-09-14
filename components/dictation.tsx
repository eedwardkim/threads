"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Mic, Square, X } from "lucide-react";
import { DICTATION_MIME_TYPES, MAX_DICTATION_BYTES, MAX_DICTATION_SECONDS } from "@/lib/dictation";
import { registerPrivateState } from "@/lib/client-state";
import { Button } from "./ui/button";

type Phase = "idle" | "permission" | "recording" | "transcribing" | "review" | "error";

export function Dictation({ disabled, context, onInsert, onBusy }: {
  disabled: boolean; context: string; onInsert: (text: string) => boolean; onBusy: (busy: boolean) => void;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [seconds, setSeconds] = useState(0);
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [terms, setTerms] = useState("");
  const [language, setLanguage] = useState("");
  const [provider, setProvider] = useState<string | null>(null);
  const [canRetry, setCanRetry] = useState(false);
  const recorder = useRef<MediaRecorder | null>(null);
  const audio = useRef<Blob | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const controller = useRef<AbortController | null>(null);
  const revision = useRef(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const options = useRef({ context: "", terms: "", language: "" });
  const busy = phase !== "idle";

  const release = useCallback(() => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
    recorder.current = null;
  }, []);

  const cancel = useCallback(() => {
    revision.current++;
    controller.current?.abort();
    if (recorder.current?.state === "recording") recorder.current.stop();
    release();
    audio.current = null;
    setCanRetry(false);
    options.current = { context: "", terms: "", language: "" };
    setTerms("");
    setLanguage("");
    setError("");
    setText("");
    setPhase("idle");
  }, [release]);

  useEffect(() => {
    onBusy(busy);
  }, [busy, onBusy]);

  useEffect(() => {
    const status = new AbortController();
    void fetch("/api/transcribe", { signal: status.signal }).then(async (response) => {
      if (response.ok) {
        const value: unknown = await response.json();
        if (typeof value === "object" && value !== null && "provider" in value && typeof value.provider === "string") setProvider(value.provider);
      }
    }).catch(() => {});
    const unregister = registerPrivateState(cancel);
    return () => {
      status.abort();
      unregister();
      cancel();
    };
  }, [cancel]);

  async function convert(blob: Blob, generation: number) {
    setPhase("transcribing");
    controller.current = new AbortController();
    try {
      const hints = { context: options.current.context, terms: options.current.terms, language: options.current.language.trim().toLowerCase() || undefined };
      const response = await fetch("/api/transcribe", {
        method: "POST", body: blob, signal: controller.current.signal,
        headers: { "Content-Type": blob.type, "X-Dictation-Options": encodeURIComponent(JSON.stringify(hints)) },
      });
      const result: unknown = await response.json();
      if (generation !== revision.current) return;
      if (!response.ok || typeof result !== "object" || result === null || !("text" in result) || typeof result.text !== "string") {
        throw new Error(typeof result === "object" && result !== null && "error" in result && typeof result.error === "string" ? result.error : "Transcription failed. Retry your recording.");
      }
      setText(result.text);
      setPhase("review");
    } catch (caught) {
      if (generation !== revision.current) return;
      setError(caught instanceof Error ? caught.message : "Transcription failed.");
      setPhase("error");
    }
  }

  async function start() {
    if (busy || disabled) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setError("Microphone recording requires a supported browser on HTTPS.");
      setPhase("error");
      return;
    }
    const generation = ++revision.current;
    options.current = { context: context.slice(-500), terms, language };
    setPhase("permission");
    setError("");
    setSeconds(0);
    try {
      const media = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (generation !== revision.current) { media.getTracks().forEach((track) => track.stop()); return; }
      stream.current = media;
      const mimeType = DICTATION_MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type));
      if (!mimeType) throw new Error("This browser cannot record WebM or MP4 audio.");
      const capture = new MediaRecorder(media, { mimeType, audioBitsPerSecond: 64_000 });
      recorder.current = capture;
      const chunks: Blob[] = [];
      let size = 0;
      capture.ondataavailable = (event) => { chunks.push(event.data); size += event.data.size; if (size >= MAX_DICTATION_BYTES && capture.state === "recording") capture.stop(); };
      capture.onerror = () => {
        revision.current++;
        release();
        audio.current = null;
        setCanRetry(false);
        setError("The microphone stopped unexpectedly. Please record again.");
        setPhase("error");
      };
      capture.onstop = () => {
        if (generation !== revision.current) return;
        release();
        const blob = new Blob(chunks, { type: mimeType });
        if (blob.size > MAX_DICTATION_BYTES) { setError("Recording is too large. Please record a shorter passage."); setPhase("error"); return; }
        audio.current = blob;
        setCanRetry(true);
        void convert(blob, generation);
      };
      capture.start(1_000);
      const started = Date.now();
      timer.current = setInterval(() => {
        const elapsed = Math.floor((Date.now() - started) / 1_000);
        setSeconds(elapsed);
        if (elapsed >= MAX_DICTATION_SECONDS && capture.state === "recording") capture.stop();
      }, 250);
      setPhase("recording");
    } catch (caught) {
      if (generation !== revision.current) return;
      release();
      setError(caught instanceof DOMException && caught.name === "NotAllowedError" ? "Microphone access was denied. Allow it in your browser settings and try again." : caught instanceof Error ? caught.message : "Microphone is unavailable.");
      setPhase("error");
    }
  }

  return <div className="dictation">
    <Button type="button" variant="ghost" size="icon" aria-label="Dictate message" title={provider ? "Dictate a message" : "Dictation needs an OpenAI or ElevenLabs key"} disabled={disabled || busy || !provider} onClick={() => void start()}><Mic size={16} /></Button>
    {busy && <section className="dictation-panel" aria-label="Voice dictation">
      <div className="dictation-heading"><strong>{provider === "mock" ? "Mock dictation" : "Voice dictation"}</strong><Button type="button" variant="ghost" size="icon" aria-label="Cancel dictation" onClick={cancel}><X size={14} /></Button></div>
      <p role="status">{phase === "permission" ? "Allow microphone access to start." : phase === "recording" ? `Recording · ${seconds}s / ${MAX_DICTATION_SECONDS}s` : phase === "transcribing" ? "Transcribing your recording…" : phase === "review" ? "Review before inserting. Nothing is sent as a message automatically." : ""}</p>
      {(phase === "permission" || phase === "recording") && <p className="dictation-note">Audio is sent to {provider} when you stop. The app does not save recordings.</p>}
      {phase === "recording" && <>
        <label>Language hint (optional ISO code)<input value={language} maxLength={3} placeholder="Auto-detect" onChange={(event) => { setLanguage(event.target.value); options.current.language = event.target.value; }} /></label>
        <label>Names and technical terms (comma-separated)<input value={terms} maxLength={500} placeholder="Eigenvalues, Supabase, CS61A" onChange={(event) => { setTerms(event.target.value); options.current.terms = event.target.value; }} /></label>
        <Button type="button" variant="secondary" onClick={() => recorder.current?.stop()}><Square size={12} />Stop and transcribe</Button>
      </>}
      {phase === "error" && <><p role="alert">{error}</p>{canRetry && <Button type="button" onClick={() => audio.current && void convert(audio.current, revision.current)}>Retry recording</Button>}</>}
      {phase === "review" && <><textarea aria-label="Review transcript" value={text} onChange={(event) => setText(event.target.value)} maxLength={100000} />{error && <p role="alert">{error}</p>}<Button type="button" disabled={!text.trim() || disabled} onClick={() => { if (onInsert(text)) cancel(); else setError("Your draft would exceed the message limit. Shorten the transcript first."); }}>Insert transcript</Button></>}
    </section>}
  </div>;
}
