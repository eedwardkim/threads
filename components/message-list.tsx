"use client";

import { memo, useLayoutEffect, useMemo, useRef } from "react";
import { ArrowDown, CornerUpLeft, Pause, RotateCcw, UserRound } from "lucide-react";
import { DEFAULT_MODEL, PROVIDER_LABEL, modelFor } from "@/lib/models";
import { streamStore, type StreamSession } from "@/lib/stream-store";
import type { Message, Thread } from "@/lib/types";
import { Markdown } from "./markdown";
import { CopyButton } from "./copy-button";
import { Button } from "./ui/button";
import { Logo } from "./logo";

export interface MessageFocus { id: string; nonce: number }
const scrollMemory = new Map<string, { top: number; following: boolean }>();

const MessageCard = memo(function MessageCard({ message, threads, activeThreadId, onOpenThread, streaming, locked, error, onCopyToMain }: {
  message: Message;
  threads: Thread[];
  activeThreadId: string | null;
  onOpenThread?: (id: string) => void;
  streaming: boolean;
  locked: boolean;
  error?: string | null;
  onCopyToMain?: (id: string) => void;
}) {
  const anchors = useMemo(() => threads.filter((thread) => thread.parentMessageId === message.id), [threads, message.id]);
  const selectable = message.role === "assistant" && message.complete && message.threadId === null && !locked;
  const time = new Date(message.createdAt);
  const prewritten = message.modelKey === null && message.role === "assistant";
  return (
    <article className={`message ${message.role}-message`} data-message-id={message.id} data-role={message.role} data-complete={String(message.complete)} data-scope={message.threadId ? "thread" : "main"} aria-busy={streaming}>
      <header className="message-header">
        <span className={`message-avatar ${message.role === "assistant" ? "assistant-avatar" : ""}`}>{message.role === "assistant" ? <Logo size={21} /> : <UserRound size={15} />}</span>
        <span className="message-author">{message.role === "assistant" ? prewritten ? "Assistant" : PROVIDER_LABEL[modelFor(message.modelKey ?? DEFAULT_MODEL).provider] : "You"}</span>
        {message.role === "assistant" && <span className="message-model">{prewritten ? "Prewritten" : modelFor(message.modelKey ?? DEFAULT_MODEL).label}</span>}
        <div className="message-actions">
          <time dateTime={time.toISOString()} suppressHydrationWarning>{time.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</time>
          {message.threadId && onCopyToMain && <Button variant="ghost" size="sm" className="copy-main-button" aria-label="Copy to main chat" title="Copy to main chat" disabled={locked} onClick={() => onCopyToMain(message.id)}><CornerUpLeft />Copy to main</Button>}
          <CopyButton text={message.content} />
        </div>
      </header>
      <div className="message-body">
        <Markdown content={message.content} anchors={anchors} activeThreadId={activeThreadId} onOpenThread={onOpenThread} streaming={streaming} selectable={selectable} />
        {streaming && <span className="sr-only" role="status">Writing an answer</span>}
        {!message.complete && !streaming && <div className="stopped-state" role="status">
          <Pause size={14} />
          <span>{error ?? "Response stopped. Your text is saved."}</span>
          <Button variant="ghost" size="sm" disabled={locked} onClick={() => void streamStore.send({ chatId: message.chatId, threadId: message.threadId, modelKey: message.modelKey ?? DEFAULT_MODEL, retryMessageId: message.id })}><RotateCcw size={13} />Retry</Button>
        </div>}
      </div>
    </article>
  );
});

export function MessageList({ chatId, threadId, messages, threads, activeThreadId = null, onOpenThread, session, locked, focus, onCopyToMain }: {
  chatId: string;
  threadId: string | null;
  messages: Message[];
  threads: Thread[];
  activeThreadId?: string | null;
  onOpenThread?: (id: string) => void;
  session?: StreamSession;
  locked: boolean;
  focus?: MessageFocus | null;
  onCopyToMain?: (id: string) => void;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const jump = useRef<HTMLButtonElement>(null);
  const initialized = useRef(false);
  const following = useRef(false);
  const lastTop = useRef(0);
  const lastRequest = useRef<string | null>(null);
  const touchY = useRef(0);
  const scope = `${chatId}:${threadId ?? "main"}`;
  const active = session?.chatId === chatId && session.phase !== "idle";
  const tail = messages.at(-1)?.content;

  function updateScroll() {
    const element = scroll.current;
    if (!element) return;
    const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight <= 1;
    if (element.scrollTop < lastTop.current) following.current = false;
    else if (nearBottom) following.current = true;
    lastTop.current = element.scrollTop;
    scrollMemory.set(scope, { top: element.scrollTop, following: following.current });
    if (jump.current) jump.current.hidden = nearBottom && following.current;
  }

  useLayoutEffect(() => {
    const element = scroll.current;
    if (!element || initialized.current) return;
    const saved = scrollMemory.get(scope);
    if (saved) {
      element.scrollTop = saved.top;
      following.current = saved.following;
    } else if (threadId) {
      element.scrollTop = element.scrollHeight;
      following.current = true;
    } else {
      const users = content.current?.querySelectorAll<HTMLElement>('[data-role="user"]');
      element.scrollTop = users?.length ? Math.max(0, users[users.length - 1].offsetTop - 24) : 0;
    }
    lastTop.current = element.scrollTop;
    if (jump.current) jump.current.hidden = element.scrollHeight - element.scrollTop - element.clientHeight <= 1;
    initialized.current = true;
  }, [scope, threadId, messages.length]);

  useLayoutEffect(() => {
    const element = scroll.current;
    if (!element) return;
    if (active && session && session.requestId !== lastRequest.current) {
      following.current = true;
      lastRequest.current = session.requestId;
    }
    if (following.current) {
      element.scrollTop = element.scrollHeight;
      lastTop.current = element.scrollTop;
    }
  }, [tail, active, session]);

  useLayoutEffect(() => {
    const element = scroll.current;
    const body = content.current;
    if (!element || !body) return;
    const observer = new ResizeObserver(() => {
      if (following.current) element.scrollTop = element.scrollHeight;
    });
    observer.observe(body);
    return () => observer.disconnect();
  }, []);

  const focusAvailable = messages.some((message) => message.id === focus?.id);
  useLayoutEffect(() => {
    if (!focus || !focusAvailable) return;
    const element = content.current?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(focus.id)}"]`);
    if (!element) return;
    following.current = false;
    element.scrollIntoView({ block: "center", behavior: "instant" });
    element.classList.add("search-flash");
    const timeout = window.setTimeout(() => element.classList.remove("search-flash"), 1800);
    return () => { window.clearTimeout(timeout); element.classList.remove("search-flash"); };
  }, [focus, focusAvailable]);

  return (
    <div className={`message-list-region ${threadId ? "thread-list-region" : "main-list-region"}`}>
      <div ref={scroll} className="message-scroll" data-testid={threadId ? "thread-scroll" : "main-scroll"} aria-label={threadId ? "Thread messages" : "Main conversation"} onScroll={updateScroll}
        onWheel={(event) => { if (event.deltaY < 0) following.current = false; }}
        onTouchStart={(event) => { touchY.current = event.touches[0]?.clientY ?? 0; }}
        onTouchMove={(event) => { if ((event.touches[0]?.clientY ?? 0) > touchY.current) following.current = false; }}>
        <div ref={content} className="message-list-content">
          {messages.map((message) => <MessageCard key={message.id} message={message} threads={threads} activeThreadId={activeThreadId} onOpenThread={onOpenThread}
            streaming={Boolean(active && session?.message?.id === message.id)} locked={locked}
            error={session?.message?.id === message.id ? session.error : null} onCopyToMain={onCopyToMain} />)}
          {active && !session?.message && <div className="connecting-state" role="status"><Logo size={20} /><span>Connecting to your model…</span></div>}
        </div>
      </div>
      <Button ref={jump} hidden variant="secondary" size="sm" className="jump-to-latest" onClick={() => {
        following.current = true;
        scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
      }}><ArrowDown size={14} />Latest</Button>
    </div>
  );
}
