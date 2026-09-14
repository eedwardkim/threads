"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowUp, Brain, ImagePlus, Loader2, Square, X } from "lucide-react";
import { attachmentStore, isImageFile, usePendingAttachments } from "@/lib/attachment-store";
import { MAX_ATTACHMENTS_PER_MESSAGE } from "@/lib/attachments/image";
import { currentClientUser, registerPrivateState } from "@/lib/client-state";
import { takeEntryPrompt } from "@/lib/entry-prompt";
import { MODELS, PROVIDER_LABEL, DEFAULT_MODEL, isModelKey, modelFor, selectableModels, type ProviderId } from "@/lib/models";
import { useModelPreference } from "@/lib/preferences";
import { scopeKey, streamStore, useStreams } from "@/lib/stream-store";
import type { Message, ProviderStatus } from "@/lib/types";
import { Button } from "./ui/button";
import { Dictation } from "./dictation";
import { insertDictation } from "@/lib/dictation";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "./ui/select";

const drafts = new Map<string, string>();
registerPrivateState(() => drafts.clear());

const PROVIDER_ORDER: ProviderId[] = ["deepseek", "anthropic", "openai"];

export function Composer({ chatId, threadId, messages, disabled = false, focusOnMount = false, providerStatus }: {
  chatId: string;
  threadId: string | null;
  messages: Message[];
  disabled?: boolean;
  focusOnMount?: boolean;
  providerStatus: ProviderStatus;
}) {
  const scope = `${currentClientUser() ?? "anonymous"}:${scopeKey(chatId, threadId)}`;
  const [draft, setDraft] = useState(() => drafts.get(scope) ?? "");
  const [dictating, setDictating] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const streams = useStreams();
  const session = streams.sessions.get(scopeKey(chatId, threadId));
  const ownActive = session !== undefined && session.phase !== "idle";
  const blocked = disabled || streams.locked || ownActive;
  const lastModel = messages.findLast((message) => message.modelKey)?.modelKey
    ?? selectableModels().find((entry) => entry.key === DEFAULT_MODEL && (providerStatus.mock || providerStatus[entry.provider]))?.key
    ?? selectableModels().find((entry) => providerStatus.mock || providerStatus[entry.provider])?.key
    ?? DEFAULT_MODEL;
  const [model, setModel] = useModelPreference(scope, lastModel);
  const pending = usePendingAttachments(scope);
  const fileInput = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [attachNote, setAttachNote] = useState<string | null>(null);
  const uploading = pending.some((item) => item.status === "uploading");
  const failed = pending.some((item) => item.status === "failed");
  const readyIds = pending.flatMap((item) => item.attachment ? [item.attachment.id] : []);
  const canSend = !blocked && !uploading && !failed && (Boolean(draft.trim()) || readyIds.length > 0);

  useEffect(() => {
    if (threadId) return;
    const userId = currentClientUser();
    const entry = takeEntryPrompt(userId, chatId);
    if (!entry) return;
    void streamStore.send({ chatId, threadId: null, content: entry, modelKey: model }).then((accepted) => {
      if (!accepted && currentClientUser() === userId && !drafts.get(scope)) {
        drafts.set(scope, entry);
        setDraft(entry);
      }
    });
  }, [chatId, threadId, scope, model]);

  useLayoutEffect(() => {
    const element = textarea.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(144, Math.max(54, element.scrollHeight))}px`;
  }, [draft]);

  useLayoutEffect(() => {
    if (focusOnMount) textarea.current?.focus({ preventScroll: true });
  }, [focusOnMount]);

  function changeDraft(value: string) {
    drafts.set(scope, value);
    setDraft(value);
  }

  async function send() {
    if (!canSend || dictating) return;
    const sent = draft;
    const attachmentIds = readyIds;
    const ok = await streamStore.send({ chatId, threadId, content: sent.trim(), modelKey: model, ...(attachmentIds.length ? { attachmentIds } : {}) });
    if (!ok) return;
    // Only clear the draft the user actually sent; a newer draft typed meanwhile is kept.
    if (drafts.get(scope) === sent) changeDraft("");
    if (attachmentIds.length) attachmentStore.clear(scope);
  }

  async function attach(files: Iterable<File>) {
    if (blocked) return;
    const skipped = await attachmentStore.add(scope, chatId, files);
    setAttachNote(skipped > 0 ? `Up to ${MAX_ATTACHMENTS_PER_MESSAGE} images per message; ${skipped} skipped.` : null);
  }

  function droppedFiles(transfer: DataTransfer | null): File[] {
    return transfer ? [...transfer.files].filter(isImageFile) : [];
  }

  return (
    <div className={`composer-wrap ${threadId ? "thread-composer-wrap" : "main-composer-wrap"}`}>
      <div className={`composer ${dragging ? "composer-dragging" : ""}`}
        onDragOver={(event) => { if (droppedFiles(event.dataTransfer).length || event.dataTransfer.types.includes("Files")) { event.preventDefault(); setDragging(true); } }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          const files = droppedFiles(event.dataTransfer);
          setDragging(false);
          if (files.length) { event.preventDefault(); void attach(files); }
        }}>
        {pending.length > 0 && <ul className="attachment-strip" aria-label="Attached images">
          {pending.map((item) => <li key={item.localId} className={`attachment-chip attachment-${item.status}`} title={item.error ?? item.name}>
            {/* eslint-disable-next-line @next/next/no-img-element -- local object URL preview */}
            <img src={item.previewUrl} alt="" />
            {item.status === "uploading" && <span className="attachment-state"><Loader2 size={14} className="spin" /></span>}
            {item.status === "failed" && <span className="attachment-state attachment-error" role="alert">{item.error}</span>}
            <button type="button" className="attachment-remove" aria-label={`Remove ${item.name}`} onClick={() => attachmentStore.remove(scope, item.localId)}><X size={12} /></button>
          </li>)}
        </ul>}
        <textarea ref={textarea} aria-label={threadId ? "Thread message" : "Main message"} data-testid={threadId ? "thread-composer" : "main-composer"}
          placeholder={threadId ? "Ask about this passage…" : "Continue the conversation…"}
          value={draft} rows={2} maxLength={100000}
          onChange={(event) => changeDraft(event.target.value)}
          onPaste={(event) => {
            const files = [...event.clipboardData.items].flatMap((item) => item.kind === "file" ? [item.getAsFile()] : []).filter((file): file is File => file !== null && isImageFile(file));
            if (files.length) { event.preventDefault(); void attach(files); }
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }} />
        <div className="composer-controls">
          <input ref={fileInput} type="file" accept="image/*" multiple hidden data-testid={threadId ? "thread-attach-input" : "main-attach-input"}
            onChange={(event) => { if (event.target.files) void attach(event.target.files); event.target.value = ""; }} />
          <Button variant="ghost" size="icon" className="attach-button" aria-label="Attach image" title={modelFor(model).vision ? "Attach image" : `Attach image (${modelFor(model).label} reads a detailed description of it)`}
            disabled={blocked || pending.length >= MAX_ATTACHMENTS_PER_MESSAGE} onClick={() => fileInput.current?.click()}><ImagePlus size={16} /></Button>
          <Select value={model} onValueChange={(value) => { if (isModelKey(value)) setModel(value); }} disabled={blocked}>
            <SelectTrigger aria-label={threadId ? "Thread model" : "Main model"} data-testid={threadId ? "thread-model" : "main-model"} className="model-pill">
              {model === "thinking" ? <Brain size={12} /> : null}
              <SelectValue>{MODELS.find((entry) => entry.key === model)?.label}</SelectValue>
            </SelectTrigger>
            <SelectContent className="min-w-56">
              {PROVIDER_ORDER.map((providerId) => {
                const models = selectableModels(model).filter((entry) => entry.provider === providerId);
                if (models.length === 0) return null;
                const available = providerStatus.mock || providerStatus[providerId];
                return <SelectGroup key={providerId}>
                  <SelectLabel>{PROVIDER_LABEL[providerId]}</SelectLabel>
                  {models.map((entry) => <SelectItem key={entry.key} value={entry.key} disabled={!available} title={entry.description}>
                    <span className="model-option"><span>{entry.label}</span><small>{entry.id}</small></span>
                  </SelectItem>)}
                </SelectGroup>;
              })}
            </SelectContent>
          </Select>
          <div className="send-controls">
            <Dictation key={scope} disabled={blocked} context={draft} onBusy={setDictating} onInsert={(text) => {
              const element = textarea.current;
              const result = insertDictation(draft, text, element?.selectionStart ?? draft.length, element?.selectionEnd ?? draft.length);
              if (result.text.length > 100000) return false;
              changeDraft(result.text);
              requestAnimationFrame(() => { element?.focus(); element?.setSelectionRange(result.cursor, result.cursor); });
              return true;
            }} />
            {ownActive ? <Button variant="secondary" size="sm" onClick={() => void streamStore.stop(chatId, threadId)} aria-label="Stop generation" className="stop-button"><Square size={12} fill="currentColor" />Stop</Button> : <>
              <span className="send-hint"><kbd>Enter</kbd></span>
              <Button size="icon" className="send-button" aria-label={threadId ? "Send thread message" : "Send main message"} disabled={!canSend || dictating} onClick={() => void send()}><ArrowUp /></Button>
            </>}
          </div>
        </div>
      </div>
      <p className="composer-note">{streams.operation ?? attachNote ?? (uploading ? "Uploading images…" : threadId ? "This conversation stays in its thread." : "Select a passage in an answer to open a thread.")}</p>
    </div>
  );
}
