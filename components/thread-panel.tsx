"use client";

import { useEffect, useMemo, useRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { ArrowLeft, Check, TextQuote, Trash2, X } from "lucide-react";
import { mergeMessages } from "@/lib/merge-messages";
import { useStreams } from "@/lib/stream-store";
import type { ProviderStatus, ThreadData } from "@/lib/types";
import { ProviderBanner } from "./provider-banner";
import { Composer } from "./composer";
import { ContextMeter } from "./context-meter";
import { MessageList, type MessageFocus } from "./message-list";
import { Button } from "./ui/button";

const EMPTY_THREADS: [] = [];

function ThreadSkeleton() {
  return <div className="thread-skeleton" role="status" aria-label="Opening thread…">
    <span className="sr-only">Opening thread…</span>
    <div className="thread-skeleton-context">
      <div className="skeleton skeleton-label-line" />
      <div className="thread-skeleton-quote">
        <div className="skeleton skeleton-line" />
        <div className="skeleton skeleton-line" />
        <div className="skeleton skeleton-line is-short" />
      </div>
      <div className="skeleton skeleton-meter" />
    </div>
    <div className="thread-skeleton-messages">
      <div className="thread-skeleton-message">
        <div className="thread-skeleton-head"><div className="skeleton skeleton-avatar" /><div className="skeleton skeleton-name" /></div>
        <div className="skeleton skeleton-line" />
        <div className="skeleton skeleton-line is-short" />
      </div>
      <div className="thread-skeleton-message">
        <div className="thread-skeleton-head"><div className="skeleton skeleton-avatar" /><div className="skeleton skeleton-name" /></div>
        <div className="skeleton skeleton-line" />
        <div className="skeleton skeleton-line" />
        <div className="skeleton skeleton-line" />
        <div className="skeleton skeleton-line is-short" />
      </div>
    </div>
    <div className="thread-skeleton-composer"><div className="skeleton skeleton-composer-box" /></div>
  </div>;
}

export function ThreadPanel({ id, data, narrow, unavailable, providerStatus, errorCode, onClose, onResolve, onDelete, onRefreshContext, focus, onCopyToMain }: {
  id: string;
  data: ThreadData | null;
  narrow: boolean;
  unavailable: boolean;
  providerStatus: ProviderStatus;
  errorCode?: string;
  onClose: () => void;
  onResolve: () => void;
  onDelete: () => void;
  onRefreshContext: () => void;
  focus?: MessageFocus | null;
  onCopyToMain?: (id: string) => void;
}) {
  const panel = useRef<HTMLElement>(null);
  const streams = useStreams();
  const session = streams.sessions.get(id);
  const messages = useMemo(() => data ? mergeMessages(data.messages, session, data.thread.chatId) : [], [data, session]);

  useEffect(() => {
    if (!narrow) return;
    const element = panel.current;
    const trap = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || !element) return;
      const items = Array.from(element.querySelectorAll<HTMLElement>('button:not(:disabled), textarea:not(:disabled), a[href], summary, [tabindex="0"]')).filter((item) => item.getClientRects().length > 0);
      const first = items[0];
      const last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    element?.addEventListener("keydown", trap);
    return () => element?.removeEventListener("keydown", trap);
  }, [narrow]);

  return <aside ref={panel} className="thread-pane" role={narrow ? "dialog" : "complementary"} aria-modal={narrow ? true : undefined} aria-labelledby="thread-heading" data-testid="thread-panel">
    <div className="thread-heading-row"><div className="thread-heading-label">{narrow ? <Button variant="ghost" size="icon" aria-label="Back to main chat" onClick={onClose}><ArrowLeft /></Button> : <TextQuote size={17} />}<h2 id="thread-heading">Thread</h2></div><div className="thread-header-actions">
      {data && <><Button variant="ghost" size="sm" onClick={onResolve} disabled={streams.locked} aria-label={data.thread.resolved ? "Reopen thread" : "Resolve thread"}><Check size={14} />{data.thread.resolved ? "Reopen" : "Resolve"}</Button><Button variant="ghost" size="icon" aria-label="Delete thread" title="Delete thread" disabled={streams.locked} onClick={onDelete}><Trash2 size={14} /></Button></>}
      {!narrow && <Button variant="ghost" size="icon" aria-label="Close thread" title="Close thread (Esc)" onClick={onClose}><X /></Button>}
    </div></div>
    {narrow && <ProviderBanner status={providerStatus} errorCode={errorCode} />}
    {data ? <>
      <div className="thread-context-header"><div className="quote-label"><span>From the main conversation</span>{data.thread.resolved && <span className="resolved-label">Resolved</span>}</div><blockquote className="thread-quote"><ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>{data.thread.anchorExact}</ReactMarkdown></blockquote>
        {!data.thread.anchorValid && <p className="anchor-warning">This anchor could not be verified. The thread is saved here without a highlight.</p>}
        <ContextMeter context={data.context} locked={streams.locked} onRefresh={onRefreshContext} />
      </div>
      {messages.length ? <MessageList key={`thread-messages:${id}`} chatId={data.thread.chatId} threadId={id} messages={messages} threads={EMPTY_THREADS} session={session} locked={streams.locked} focus={focus} onCopyToMain={onCopyToMain} /> : <div className="empty-thread"><TextQuote size={29} /><h3>Stay with this thought.</h3><p>Ask a follow-up about this passage.<br />The main conversation stays as it is.</p></div>}
      <Composer key={`thread-composer:${id}`} chatId={data.thread.chatId} threadId={id} messages={messages} disabled={unavailable} focusOnMount providerStatus={providerStatus} />
    </> : <ThreadSkeleton />}
  </aside>;
}
