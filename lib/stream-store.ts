"use client";

import { useSyncExternalStore } from "react";
import { ONE_GENERATION_AT_A_TIME } from "./generation-policy";
import type { ModelKey } from "./models";
import type { Message, StreamEvent } from "./types";

export interface StreamSession {
  requestId: string;
  chatId: string;
  threadId: string | null;
  phase: "connecting" | "streaming" | "idle";
  message: Message | null;
  userMessage: Message | null;
  error: string | null;
}

interface Notice {
  id: number;
  message: string;
  code: string;
  messageId?: string;
}

interface StreamsSnapshot {
  sessions: ReadonlyMap<string | null, StreamSession>;
  locked: boolean;
  active: boolean;
  operation: string | null;
  notice: Notice | null;
}

interface SendInput {
  chatId: string;
  threadId: string | null;
  content?: string;
  modelKey: ModelKey;
  retryMessageId?: string;
}

interface ActiveStream extends Pick<StreamSession, "requestId" | "chatId" | "threadId"> {
  controller: AbortController;
  reader: ReadableStreamDefaultReader<Uint8Array> | null;
}

const initialSnapshot: StreamsSnapshot = { sessions: new Map(), locked: false, active: false, operation: null, notice: null };
let snapshot = initialSnapshot;
const listeners = new Set<() => void>();
const requests = new Map<string, ActiveStream>();
let operation: { label: string; controller: AbortController } | null = null;
let noticeId = 0;
let listeningForPagehide = false;
const networkMessage = "The connection was interrupted. Your text is saved. Please retry.";
const busyMessage = "Another operation is running. Stop it or wait for it to finish.";

class StreamFailure extends Error {
  constructor(message = networkMessage, public code = "network") {
    super(message);
    this.name = "StreamFailure";
  }
}

function publish(sessions = snapshot.sessions, notice = snapshot.notice): void {
  const active = requests.size > 0 || operation !== null;
  snapshot = { sessions, notice, active, locked: ONE_GENERATION_AT_A_TIME && active, operation: operation?.label ?? null };
  listeners.forEach((listener) => listener());
}

function sessionFor(stream: ActiveStream): StreamSession | undefined {
  const session = snapshot.sessions.get(stream.threadId);
  return session?.requestId === stream.requestId && session.chatId === stream.chatId ? session : undefined;
}

function update(stream: ActiveStream, changes: Partial<StreamSession>, notice = snapshot.notice): void {
  const session = sessionFor(stream);
  if (session) publish(new Map(snapshot.sessions).set(stream.threadId, { ...session, ...changes }), notice);
}

function report(stream: ActiveStream, error: StreamFailure, messageId?: string): void {
  const session = sessionFor(stream);
  update(stream, { error: messageId && session?.message?.id === messageId ? error.message : session?.error ?? null }, {
    id: ++noticeId, message: error.message, code: error.code, ...(messageId ? { messageId } : {}),
  });
}

function finish(stream: ActiveStream, receivedFinish: boolean): void {
  requests.delete(stream.requestId);
  const session = sessionFor(stream);
  if (session) {
    update(stream, { phase: "idle", message: session.message && !receivedFinish ? { ...session.message, complete: false } : session.message });
  } else {
    publish();
  }
}

function refresh(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new window.Event("threads:refresh"));
}

function isAbort(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}

function matchesScope(stream: ActiveStream, message: Message): boolean {
  return Boolean(message && message.chatId === stream.chatId && message.threadId === stream.threadId && typeof message.id === "string" && typeof message.content === "string");
}

function receive(stream: ActiveStream, event: StreamEvent): void {
  const session = sessionFor(stream);
  if (!session) return;
  switch (event.type) {
    case "start":
      if (!matchesScope(stream, event.message) || event.message.role !== "assistant"
        || (event.userMessage !== null && (!matchesScope(stream, event.userMessage) || event.userMessage.role !== "user"))) throw new StreamFailure();
      update(stream, { phase: "streaming", message: event.message, userMessage: event.userMessage, error: null });
      break;
    case "delta":
      if (!session.message || session.message.id !== event.messageId || typeof event.text !== "string") throw new StreamFailure();
      update(stream, { phase: "streaming", message: { ...session.message, content: session.message.content + event.text, complete: false } });
      break;
    case "error":
      if (typeof event.message !== "string" || typeof event.code !== "string"
        || (event.messageId && session.message?.id !== event.messageId)) throw new StreamFailure();
      report(stream, new StreamFailure(event.message, event.code), event.messageId);
      break;
    case "finish":
      if (!matchesScope(stream, event.message) || event.message.role !== "assistant" || session.message?.id !== event.message.id) throw new StreamFailure();
      update(stream, { message: event.message });
      break;
    default:
      throw new StreamFailure();
  }
}

function releaseReader(stream: ActiveStream): void {
  const reader = stream.reader;
  stream.reader = null;
  if (!reader) return;
  try {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  } catch {
    stream.controller.abort();
  }
}

async function consume(stream: ActiveStream, reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  let receivedFinish = false;
  let receivedError = false;
  const decoder = new TextDecoder();
  let buffer = "";
  const accept = (line: string) => {
    if (!line.trim()) return;
    const event = JSON.parse(line) as StreamEvent;
    receive(stream, event);
    if (event.type === "finish") receivedFinish = true;
    if (event.type === "error") receivedError = true;
  };
  try {
    while (!receivedFinish && !stream.controller.signal.aborted) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let newline: number;
      while (!receivedFinish && (newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        accept(line);
      }
      if (done) {
        if (!receivedFinish && buffer.trim()) accept(buffer);
        break;
      }
    }
    if (!receivedFinish && !receivedError && !stream.controller.signal.aborted) throw new StreamFailure();
  } catch (error) {
    if (!receivedError && !stream.controller.signal.aborted && !isAbort(error)) {
      report(stream, error instanceof StreamFailure ? error : new StreamFailure(), sessionFor(stream)?.message?.id);
    }
  } finally {
    releaseReader(stream);
    finish(stream, receivedFinish);
    refresh();
  }
}

async function responseError(response: Response): Promise<StreamFailure> {
  try {
    const body = await response.json() as { error?: unknown; code?: unknown };
    return new StreamFailure(typeof body.error === "string" ? body.error : networkMessage, typeof body.code === "string" ? body.code : "network");
  } catch {
    return new StreamFailure();
  }
}

function watchPagehide(): void {
  if (typeof window !== "undefined" && !listeningForPagehide) {
    window.addEventListener("pagehide", stop);
    listeningForPagehide = true;
  }
}

async function send(input: SendInput): Promise<boolean> {
  watchPagehide();
  const existing = snapshot.sessions.get(input.threadId);
  if ((existing && existing.phase !== "idle") || (ONE_GENERATION_AT_A_TIME && snapshot.active)) {
    publish(snapshot.sessions, { id: ++noticeId, message: busyMessage, code: "generation_busy" });
    return false;
  }
  const stream: ActiveStream = { requestId: crypto.randomUUID(), chatId: input.chatId, threadId: input.threadId, controller: new AbortController(), reader: null };
  requests.set(stream.requestId, stream);
  publish(new Map(snapshot.sessions).set(input.threadId, {
    requestId: stream.requestId, chatId: input.chatId, threadId: input.threadId,
    phase: "connecting", message: null, userMessage: null, error: null,
  }), null);
  let started = false;
  let response: Response | null = null;
  try {
    response = await fetch("/api/generate", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...input, requestId: stream.requestId }), signal: stream.controller.signal,
    });
    if (!response.ok) throw await responseError(response);
    if (!response.body || !response.headers.get("content-type")?.toLowerCase().includes("application/x-ndjson")) throw new StreamFailure();
    const reader = response.body.getReader();
    stream.reader = reader;
    stream.controller.signal.throwIfAborted();
    started = true;
    void consume(stream, reader);
    return true;
  } catch (error) {
    if (!stream.controller.signal.aborted && !isAbort(error)) report(stream, error instanceof StreamFailure ? error : new StreamFailure());
    return false;
  } finally {
    if (!started) {
      const interrupted = stream.controller.signal.aborted;
      if (stream.reader) releaseReader(stream);
      else if (response?.body && !response.body.locked) void response.body.cancel().catch(() => undefined);
      stream.controller.abort();
      finish(stream, false);
      if (interrupted || response?.ok) refresh();
    }
  }
}

async function requestStop(requestId: string): Promise<void> {
  await fetch(`/api/generate?id=${encodeURIComponent(requestId)}`, { method: "DELETE", keepalive: true });
}

function stop(): void {
  operation?.controller.abort();
  for (const stream of requests.values()) {
    void requestStop(stream.requestId).catch(() => undefined);
    stream.controller.abort();
    if (stream.reader) void stream.reader.cancel().catch(() => undefined);
  }
}

async function runOperation<T>(label: string, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
  watchPagehide();
  if (operation || (ONE_GENERATION_AT_A_TIME && snapshot.active)) throw new StreamFailure(busyMessage, "generation_busy");
  const current = { label, controller: new AbortController() };
  operation = current;
  publish(snapshot.sessions, null);
  try {
    return await task(current.controller.signal);
  } finally {
    if (operation === current) operation = null;
    publish();
  }
}

function subscribe(listener: () => void): () => void {
  watchPagehide();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const getSnapshot = () => snapshot;
const getServerSnapshot = () => initialSnapshot;

export function useStreams(): StreamsSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

export const streamStore = { send, stop, runOperation };
