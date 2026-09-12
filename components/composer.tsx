"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { ArrowUp, Brain, Square } from "lucide-react";
import { MODELS, PROVIDER_LABEL, DEFAULT_MODEL, isModelKey, type ProviderId } from "@/lib/models";
import { useModelPreference } from "@/lib/preferences";
import { streamStore, useStreams } from "@/lib/stream-store";
import type { Message, ProviderStatus } from "@/lib/types";
import { Button } from "./ui/button";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "./ui/select";

const drafts = new Map<string, string>();

const PROVIDER_ORDER: ProviderId[] = ["deepseek", "anthropic", "openai"];

export function Composer({ chatId, threadId, messages, disabled = false, focusOnMount = false, providerStatus }: {
  chatId: string;
  threadId: string | null;
  messages: Message[];
  disabled?: boolean;
  focusOnMount?: boolean;
  providerStatus: ProviderStatus;
}) {
  const scope = `${chatId}:${threadId ?? "main"}`;
  const [draft, setDraft] = useState(() => drafts.get(scope) ?? "");
  const textarea = useRef<HTMLTextAreaElement>(null);
  const streams = useStreams();
  const session = streams.sessions.get(threadId);
  const ownActive = session?.chatId === chatId && session.phase !== "idle";
  const blocked = disabled || streams.locked || ownActive;
  const lastModel = messages.findLast((message) => message.modelKey)?.modelKey ?? DEFAULT_MODEL;
  const [model, setModel] = useModelPreference(scope, lastModel);

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
    if (blocked || !draft.trim()) return;
    if (await streamStore.send({ chatId, threadId, content: draft.trim(), modelKey: model })) changeDraft("");
  }

  return (
    <div className={`composer-wrap ${threadId ? "thread-composer-wrap" : "main-composer-wrap"}`}>
      <div className="composer">
        <textarea ref={textarea} aria-label={threadId ? "Thread message" : "Main message"} data-testid={threadId ? "thread-composer" : "main-composer"}
          placeholder={threadId ? "Ask about this passage…" : "Continue the conversation…"}
          value={draft} rows={2} maxLength={100000}
          onChange={(event) => changeDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void send();
            }
          }} />
        <div className="composer-controls">
          <Select value={model} onValueChange={(value) => { if (isModelKey(value)) setModel(value); }} disabled={blocked}>
            <SelectTrigger aria-label={threadId ? "Thread model" : "Main model"} data-testid={threadId ? "thread-model" : "main-model"} className="model-pill">
              {model === "thinking" ? <Brain size={12} /> : null}
              <SelectValue>{MODELS.find((entry) => entry.key === model)?.label}</SelectValue>
            </SelectTrigger>
            <SelectContent className="min-w-56">
              {PROVIDER_ORDER.map((providerId) => {
                const models = MODELS.filter((entry) => entry.provider === providerId);
                if (models.length === 0) return null;
                const available = providerStatus.mock || providerStatus[providerId];
                return <SelectGroup key={providerId}>
                  <SelectLabel>{PROVIDER_LABEL[providerId]}</SelectLabel>
                  {models.map((entry) => <SelectItem key={entry.key} value={entry.key} disabled={!available}>
                    <span className="model-option"><span>{entry.label}</span><small>{entry.description}</small></span>
                  </SelectItem>)}
                </SelectGroup>;
              })}
            </SelectContent>
          </Select>
          <div className="send-controls">
            {streams.active ? <Button variant="secondary" size="sm" onClick={() => streamStore.stop()} aria-label="Stop generation" className="stop-button"><Square size={12} fill="currentColor" />Stop</Button> : <>
              <span className="send-hint"><kbd>⌘</kbd><kbd>Enter</kbd></span>
              <Button size="icon" className="send-button" aria-label={threadId ? "Send thread message" : "Send main message"} disabled={blocked || !draft.trim()} onClick={() => void send()}><ArrowUp /></Button>
            </>}
          </div>
        </div>
      </div>
      <p className="composer-note">{streams.operation ?? (threadId ? "This conversation stays in its thread." : "Select a passage in an answer to open a thread.")}</p>
    </div>
  );
}
