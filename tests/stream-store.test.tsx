import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bindClientUser, clearPrivateClientState } from "../lib/client-state";
import { scopeKey, streamStore, useStreams } from "../lib/stream-store";
import type { Message, StreamEvent } from "../lib/types";

function untilAborted(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) resolve();
    else signal?.addEventListener("abort", () => resolve(), { once: true });
  });
}

function row(input: Partial<Message> = {}): Message {
  return {
    id: "assistant", chatId: "chat", threadId: null, role: "assistant", content: "", modelKey: "fast",
    complete: false, inputTokens: null, outputTokens: null, createdAt: 1, ...input,
  };
}

function wire() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
  return {
    response: new Response(stream, { headers: { "content-type": "application/x-ndjson" } }),
    push(...events: StreamEvent[]) { controller.enqueue(new TextEncoder().encode(events.map((event) => JSON.stringify(event)).join("\n") + "\n")); },
    controller,
  };
}

const main = scopeKey("chat", null);

describe("component-independent, scope-keyed stream store", () => {
  let root: Root;
  let current: ReturnType<typeof useStreams>;
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

  function Probe() {
    current = useStreams();
    return null;
  }

  beforeEach(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    bindClientUser("user-a");
    root = createRoot(document.createElement("div"));
    await act(() => root.render(createElement(Probe)));
  });

  afterEach(async () => {
    await act(async () => streamStore.stopAll());
    await act(() => root.unmount());
    streamStore.reset();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("connects synchronously, resolves send before EOF, decodes split NDJSON, and keeps an idle bridge", async () => {
    const response = wire();
    let accept!: (response: Response) => void;
    fetchMock.mockReturnValueOnce(new Promise((resolve) => { accept = resolve; }));
    let sending!: Promise<boolean>;
    const previous = current;
    act(() => { sending = streamStore.send({ chatId: "chat", threadId: null, content: "Question", modelKey: "fast" }); });
    expect(current).not.toBe(previous);
    expect(previous.sessions.get(main)?.phase ?? "idle").toBe("idle");
    expect(current).toMatchObject({ active: true, locked: false, operation: null });
    expect(current.sessions.get(main)).toMatchObject({ phase: "connecting", chatId: "chat" });
    await act(async () => {
      expect(await streamStore.send({ chatId: "chat", threadId: null, content: "Duplicate in the same scope", modelKey: "fast" })).toBe(false);
      accept(response.response);
      expect(await sending).toBe(true);
    });
    expect(current.notice).toMatchObject({ code: "generation_busy" });
    const userMessage = row({ id: "user", role: "user", content: "Question", complete: true });
    const message = row();
    const prefix = new TextEncoder().encode(`${JSON.stringify({ type: "start", message, userMessage })}\n${JSON.stringify({ type: "delta", messageId: message.id, text: "漢字 text" })}\n`);
    const split = prefix.indexOf(0xe6) + 1;
    await act(async () => {
      response.controller.enqueue(prefix.subarray(0, 17));
      response.controller.enqueue(prefix.subarray(17, split));
      response.controller.enqueue(prefix.subarray(split));
    });
    expect(current.sessions.get(main)).toMatchObject({ phase: "streaming", message: { content: "漢字 text", complete: false }, userMessage });
    const refresh = vi.fn();
    window.addEventListener("threads:refresh", refresh, { once: true });
    await act(async () => {
      response.controller.enqueue(new TextEncoder().encode(JSON.stringify({ type: "finish", message: { ...message, content: "漢字 text", complete: true, inputTokens: 4, outputTokens: 2 } })));
      response.controller.close();
    });
    expect(current).toMatchObject({ active: false, locked: false });
    expect(current.sessions.get(main)).toMatchObject({ phase: "idle", message: { content: "漢字 text", complete: true, inputTokens: 4, outputTokens: 2 }, userMessage });
    expect(refresh).toHaveBeenCalledOnce();
    expect((refresh.mock.calls[0][0] as CustomEvent).detail).toMatchObject({ chatId: "chat", threadId: null });
  });

  it("replaces raw streamed math with the authoritative normalized finish content", async () => {
    const response = wire();
    fetchMock.mockResolvedValueOnce(response.response);
    const message = row();
    const raw = String.raw`Answer: \(x^2\).`;
    await act(async () => {
      await streamStore.send({ chatId: "chat", threadId: null, content: "Question", modelKey: "fast" });
      response.push({ type: "start", message, userMessage: null }, { type: "delta", messageId: message.id, text: raw });
    });
    expect(current.sessions.get(main)?.message?.content).toBe(raw);
    await act(async () => {
      response.push({ type: "finish", message: { ...message, content: "Answer: $x^2$.", complete: true } });
      response.controller.close();
    });
    expect(current.sessions.get(main)).toMatchObject({ phase: "idle", message: { content: "Answer: $x^2$.", complete: true } });
  });

  it("keeps reading when the observing component unmounts", async () => {
    const response = wire();
    fetchMock.mockResolvedValueOnce(response.response);
    const message = row({ id: "independent", threadId: "independent-thread" });
    await act(async () => {
      expect(await streamStore.send({ chatId: "chat", threadId: message.threadId, content: "Question", modelKey: "fast" })).toBe(true);
      response.push({ type: "start", message, userMessage: null });
    });
    await act(() => root.unmount());
    await act(async () => {
      response.push({ type: "delta", messageId: message.id, text: "Still reading" }, { type: "finish", message: { ...message, content: "Still reading", complete: true } });
      response.controller.close();
    });
    root = createRoot(document.createElement("div"));
    await act(() => root.render(createElement(Probe)));
    expect(current.sessions.get(scopeKey("chat", message.threadId))).toMatchObject({ phase: "idle", message: { content: "Still reading", complete: true } });
  });

  it("preserves root HTTP error codes without inventing an affected message", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ error: "Check the configured key", code: "invalid_key" }, { status: 401 }));
    await act(async () => {
      expect(await streamStore.send({ chatId: "rejected-chat", threadId: null, content: "Question", modelKey: "fast" })).toBe(false);
    });
    expect(current).toMatchObject({ active: false, locked: false, notice: { message: "Check the configured key", code: "invalid_key" } });
    expect(current.notice?.messageId).toBeUndefined();
    expect(current.sessions.get(scopeKey("rejected-chat", null))).toMatchObject({ phase: "idle", chatId: "rejected-chat", message: null, userMessage: null, error: null });
  });

  it("cancels an unusable initial response and releases its browser fetch", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    fetchMock.mockResolvedValueOnce(new Response(body, { headers: { "content-type": "text/html" } }));
    await act(async () => {
      expect(await streamStore.send({ chatId: "chat", threadId: null, content: "Question", modelKey: "fast" })).toBe(false);
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(current).toMatchObject({ active: false, locked: false, notice: { code: "network" } });
    expect(current.sessions.get(main)).toMatchObject({ phase: "idle", message: null });
  });

  it("marks a reader ending without finish incomplete and retryable", async () => {
    const response = wire();
    fetchMock.mockResolvedValueOnce(response.response);
    const message = row({ id: "interrupted", chatId: "interrupted-chat" });
    await act(async () => {
      await streamStore.send({ chatId: message.chatId, threadId: null, content: "Question", modelKey: "fast" });
      response.push({ type: "start", message, userMessage: null }, { type: "delta", messageId: message.id, text: "Saved partial" });
      response.controller.close();
    });
    expect(current.sessions.get(scopeKey(message.chatId, null))).toMatchObject({ phase: "idle", message: { content: "Saved partial", complete: false }, error: expect.any(String) });
    expect(current.notice).toMatchObject({ messageId: message.id, code: "network" });
    expect(current.active).toBe(false);
  });

  it("retains an affected-message error through its incomplete finish", async () => {
    const response = wire();
    fetchMock.mockResolvedValueOnce(response.response);
    const message = row({ id: "rate-limited" });
    await act(async () => {
      await streamStore.send({ chatId: "chat", threadId: null, retryMessageId: message.id, modelKey: "thinking" });
      response.push({ type: "start", message, userMessage: null }, { type: "error", message: "Wait, then retry", code: "rate_limit", messageId: message.id }, { type: "finish", message });
      response.controller.close();
    });
    expect(current.sessions.get(main)).toMatchObject({ phase: "idle", message: { complete: false }, error: "Wait, then retry" });
    expect(current.notice).toMatchObject({ messageId: message.id, code: "rate_limit" });
  });

  it("preserves a provider error code if the reader then fails before finish", async () => {
    const response = wire();
    fetchMock.mockResolvedValueOnce(response.response);
    const message = row({ id: "rejected-stream" });
    await act(async () => {
      await streamStore.send({ chatId: "chat", threadId: null, content: "Question", modelKey: "fast" });
      response.push({ type: "start", message, userMessage: null }, { type: "error", message: "The key was rejected", code: "invalid_key", messageId: message.id });
    });
    await act(async () => response.controller.error(new Error("Transport closed")));
    expect(current.notice).toMatchObject({ message: "The key was rejected", code: "invalid_key", messageId: message.id });
    expect(current.sessions.get(main)).toMatchObject({ phase: "idle", message: { complete: false }, error: "The key was rejected" });
    expect(current.active).toBe(false);
  });

  it("shows message-free stream errors only as notices", async () => {
    const response = wire();
    fetchMock.mockResolvedValueOnce(response.response);
    await act(async () => {
      await streamStore.send({ chatId: "chat", threadId: null, content: "Question", modelKey: "fast" });
      response.push({ type: "error", message: "Try again shortly", code: "busy" });
      response.controller.close();
    });
    expect(current.notice).toMatchObject({ message: "Try again shortly", code: "busy" });
    expect(current.notice?.messageId).toBeUndefined();
    expect(current.sessions.get(main)).toMatchObject({ phase: "idle", message: null, error: null });
  });

  it("does not merge rows from another chat or scope into the requested session", async () => {
    const response = wire();
    fetchMock.mockResolvedValueOnce(response.response);
    await act(async () => {
      await streamStore.send({ chatId: "requested-chat", threadId: null, content: "Question", modelKey: "fast" });
      response.push({ type: "start", message: row({ chatId: "wrong-chat" }), userMessage: null });
      response.controller.close();
    });
    expect(current.sessions.get(scopeKey("requested-chat", null))).toMatchObject({ chatId: "requested-chat", message: null, phase: "idle" });
    expect(current.notice).toMatchObject({ code: "network" });
  });

  it("locks operations before their first await and releases them even when the task throws", async () => {
    let reject!: (error: Error) => void;
    let result!: Promise<unknown>;
    act(() => {
      result = streamStore.runOperation("Preparing thread", () => new Promise((_, fail) => { reject = fail; })).catch((error: unknown) => error);
    });
    expect(current).toMatchObject({ active: false, locked: true, operation: "Preparing thread" });
    await act(async () => {
      await expect(streamStore.runOperation("Second", async () => undefined)).rejects.toMatchObject({ code: "operation_busy" });
      reject(new Error("Task failed"));
      expect(await result).toEqual(new Error("Task failed"));
    });
    expect(current).toMatchObject({ active: false, locked: false, operation: null });
  });

  it("streams independent scopes concurrently, guards each scope, targets Stop, and stopAll ends everything", async () => {
    const first = wire();
    const second = wire();
    fetchMock.mockResolvedValueOnce(first.response).mockResolvedValueOnce(second.response);
    const a = row({ id: "first-partial", threadId: "first-thread" });
    const b = row({ id: "second-partial", threadId: "second-thread" });
    let operationSignal!: AbortSignal;
    let operation!: Promise<unknown>;
    await act(async () => {
      expect(await streamStore.send({ chatId: "chat", threadId: a.threadId, content: "A", modelKey: "fast" })).toBe(true);
      expect(await streamStore.send({ chatId: "chat", threadId: b.threadId, content: "B", modelKey: "fast" })).toBe(true);
      first.push({ type: "start", message: a, userMessage: null }, { type: "delta", messageId: a.id, text: "A partial" });
      second.push({ type: "start", message: b, userMessage: null }, { type: "delta", messageId: b.id, text: "B partial" });
      operation = streamStore.runOperation("Concurrent operation", async (signal) => { operationSignal = signal; await untilAborted(signal); signal.throwIfAborted(); }).catch((error: unknown) => error);
    });
    expect(current).toMatchObject({ active: true, locked: true, operation: "Concurrent operation" });
    await act(async () => {
      expect(await streamStore.send({ chatId: "chat", threadId: a.threadId, content: "Duplicate", modelKey: "fast" })).toBe(false);
      streamStore.stop("chat", a.threadId);
    });
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(1);
    expect(current.sessions.get(scopeKey("chat", a.threadId))?.phase).toBe("idle");
    expect(current.sessions.get(scopeKey("chat", b.threadId))?.phase).toBe("streaming");
    expect(operationSignal.aborted).toBe(false);
    await act(async () => {
      streamStore.stopAll();
      await operation;
    });
    expect(operationSignal.aborted).toBe(true);
    const stops = fetchMock.mock.calls.filter(([, init]) => init?.method === "DELETE");
    expect(stops).toHaveLength(2);
    expect(stops.every(([url, init]) => String(url).startsWith("/api/generate?id=") && init?.keepalive === true)).toBe(true);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST").every(([, init]) => init?.signal?.aborted)).toBe(true);
    expect(current.sessions.get(scopeKey("chat", a.threadId))).toMatchObject({ phase: "idle", message: { content: "A partial", complete: false }, error: null });
    expect(current.sessions.get(scopeKey("chat", b.threadId))).toMatchObject({ phase: "idle", message: { content: "B partial", complete: false }, error: null });
    expect(current).toMatchObject({ active: false, locked: false, operation: null });
  });

  it("asks the server before giving up on an ambiguous transport failure and never restarts blindly", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    fetchMock.mockResolvedValueOnce(Response.json({ job: { id: "job", status: "running" } }));
    await act(async () => {
      expect(await streamStore.send({ chatId: "chat", threadId: null, content: "Question", modelKey: "fast" })).toBe(true);
    });
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect(String(fetchMock.mock.calls[1][0])).toMatch(/^\/api\/generate\?id=/);
    expect(current.notice).toMatchObject({ code: "reconnect" });
    expect(current.sessions.get(main)?.phase).toBe("idle");
  });

  it("discards late events from a previous account after an account switch", async () => {
    const response = wire();
    fetchMock.mockResolvedValueOnce(response.response);
    const message = row();
    await act(async () => {
      await streamStore.send({ chatId: "chat", threadId: null, content: "Question", modelKey: "fast" });
      response.push({ type: "start", message, userMessage: null });
    });
    expect(current.sessions.get(main)?.phase).toBe("streaming");
    await act(async () => { clearPrivateClientState(); bindClientUser("user-b"); });
    const refresh = vi.fn();
    window.addEventListener("threads:refresh", refresh);
    await act(async () => {
      // The reader was cancelled by the reset; a late push must not reach any session either way.
      try { response.push({ type: "delta", messageId: message.id, text: "Late text for user A" }); response.controller.close(); } catch { /* already cancelled */ }
    });
    window.removeEventListener("threads:refresh", refresh);
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(current.sessions.size).toBe(0);
    expect(current.notice).toBeNull();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("stops a connecting request on pagehide without an abort error notice", async () => {
    fetchMock.mockImplementationOnce(async (_, init) => {
      await untilAborted(init?.signal ?? undefined);
      throw new DOMException("Aborted", "AbortError");
    });
    let sending!: Promise<boolean>;
    await act(async () => {
      sending = streamStore.send({ chatId: "reload-chat", threadId: null, content: "Question", modelKey: "fast" });
      window.dispatchEvent(new Event("pagehide"));
      expect(await sending).toBe(false);
    });
    expect(current).toMatchObject({ active: false, locked: false, notice: null });
    expect(current.sessions.get(scopeKey("reload-chat", null))?.phase).toBe("idle");
  });

  it("returns one stable, empty server snapshot without requiring window", () => {
    const snapshots: ReturnType<typeof useStreams>[] = [];
    function ServerProbe() {
      snapshots.push(useStreams());
      return null;
    }
    vi.stubGlobal("window", undefined);
    renderToString(createElement(ServerProbe));
    renderToString(createElement(ServerProbe));
    expect(snapshots[0]).toBe(snapshots[1]);
    expect(snapshots[0]).toMatchObject({ active: false, locked: false, operation: null, notice: null });
    expect(snapshots[0].sessions.size).toBe(0);
    vi.unstubAllGlobals();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("fetch", fetchMock);
  });
});
