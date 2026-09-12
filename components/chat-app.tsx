"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Menu, Plus } from "lucide-react";
import { ProviderBanner } from "./provider-banner";
import { Toaster, toast } from "sonner";
import { requestJson, errorText } from "@/lib/client-api";
import { mergeMessages } from "@/lib/merge-messages";
import { useThemePreference } from "@/lib/preferences";
import { streamStore, useStreams } from "@/lib/stream-store";
import { useNarrowScreen } from "@/lib/use-narrow-screen";
import type { AppData, Chat, ChatData, ProviderStatus, SearchResult, Thread, ThreadData } from "@/lib/types";
import { Sidebar } from "./sidebar";
import { SearchPanel } from "./search-panel";
import { ChatSwitcher } from "./chat-switcher";
import { Composer } from "./composer";
import { MessageList, type MessageFocus } from "./message-list";
import { SelectionReply, type SpanSelection } from "./selection-reply";
import { ThreadPanel } from "./thread-panel";
import { Logo } from "./logo";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";

type DeleteTarget = { kind: "chat" | "thread"; id: string; title: string };

function updateLocation(chatId: string | null, threadId: string | null) {
  const params = new URLSearchParams();
  if (chatId) params.set("chat", chatId);
  if (threadId) params.set("thread", threadId);
  window.history.replaceState(null, "", `${window.location.pathname}${params.size ? `?${params}` : ""}`);
}

export function ChatApp({ initialData, providerStatus, initialThread = null }: { initialData: AppData; providerStatus: ProviderStatus; initialThread?: ThreadData | null }) {
  const [chats, setChats] = useState(initialData.chats);
  const [current, setCurrent] = useState(initialData.current);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(initialThread?.thread.id ?? null);
  const [threadData, setThreadData] = useState(initialThread);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [mainFocus, setMainFocus] = useState<MessageFocus | null>(null);
  const [threadFocus, setThreadFocus] = useState<MessageFocus | null>(null);
  const [deleting, setDeleting] = useState<DeleteTarget | null>(null);
  const [deletePending, setDeletePending] = useState(false);
  const currentId = useRef(current?.chat.id ?? null);
  const threadId = useRef(activeThreadId);
  const loadVersion = useRef(0);
  const threadVersion = useRef(0);
  const focusVersion = useRef(0);
  const returnFocus = useRef<HTMLElement | null>(null);
  const [theme, toggleTheme] = useThemePreference();
  const narrow = useNarrowScreen();
  const [sidebarWidth, setSidebarWidth] = useState(220);
  const [threadWidth, setThreadWidth] = useState(340);
  const sidebarWidthRef = useRef(220);
  const threadWidthRef = useRef(340);
  const shellRef = useRef<HTMLDivElement>(null);
  const streams = useStreams();
  const mainSession = streams.sessions.get(null);
  const messages = useMemo(() => current ? mergeMessages(current.messages, mainSession, current.chat.id) : [], [current, mainSession]);
  const unavailable = !providerStatus.mock && (!providerStatus.deepseek && !providerStatus.anthropic && !providerStatus.openai);

  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
  useEffect(() => {
    if (streams.notice && !streams.notice.messageId) toast.error(streams.notice.message);
  }, [streams.notice]);

  useLayoutEffect(() => {
    const el = shellRef.current;
    if (!el) return;
    el.style.setProperty('--sidebar-width', `${sidebarWidth}px`);
    el.style.setProperty('--thread-width', `${threadWidth}px`);
  }, [sidebarWidth, threadWidth]);

  useLayoutEffect(() => {
    try {
      const sw = localStorage.getItem('threadllm:sidebar-width');
      const tw = localStorage.getItem('threadllm:thread-width');
      if (sw) { const n = Number(sw); if (n >= 160 && n <= 400) { setSidebarWidth(n); sidebarWidthRef.current = n; } }
      if (tw) { const n = Number(tw); if (n >= 260 && n <= 600) { setThreadWidth(n); threadWidthRef.current = n; } }
    } catch {}
  }, []);

  const startResize = useCallback((panel: 'sidebar' | 'thread', startX: number) => {
    const startWidth = panel === 'sidebar' ? sidebarWidthRef.current : threadWidthRef.current;
    const shell = shellRef.current;
    if (!shell) return;
    const threadShell = panel === 'thread' ? shell.querySelector<HTMLElement>('.thread-shell') : null;
    if (threadShell) threadShell.style.transition = 'none';
    const onMove = (e: MouseEvent) => {
      const delta = e.clientX - startX;
      const w = panel === 'sidebar'
        ? Math.max(160, Math.min(400, startWidth + delta))
        : Math.max(260, Math.min(600, startWidth - delta));
      if (panel === 'sidebar') sidebarWidthRef.current = w;
      else threadWidthRef.current = w;
      shell.style.setProperty(`--${panel}-width`, `${w}px`);
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.removeProperty('cursor');
      document.body.style.removeProperty('user-select');
      if (threadShell) threadShell.style.transition = '';
      setSidebarWidth(sidebarWidthRef.current);
      setThreadWidth(threadWidthRef.current);
      try {
        localStorage.setItem('threadllm:sidebar-width', String(sidebarWidthRef.current));
        localStorage.setItem('threadllm:thread-width', String(threadWidthRef.current));
      } catch {}
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, []);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    if (narrow) setMobileOpen(false);
  }, [narrow]);

  const showSearch = useCallback(() => {
    setSearchOpen(true);
    if (narrow) setMobileOpen(true);
    requestAnimationFrame(() => document.querySelector<HTMLInputElement>('[aria-label="Search messages"]')?.focus());
  }, [narrow]);

  const closeThread = useCallback(() => {
    threadId.current = null;
    threadVersion.current += 1;
    setActiveThreadId(null);
    setThreadData(null);
    updateLocation(currentId.current, null);
    if (returnFocus.current?.isConnected) returnFocus.current.focus({ preventScroll: true });
  }, []);

  const openThread = useCallback(async (id: string) => {
    const version = ++threadVersion.current;
    returnFocus.current = document.activeElement as HTMLElement;
    threadId.current = id;
    setActiveThreadId(id);
    setThreadData((existing) => existing?.thread.id === id ? existing : null);
    setMobileOpen(false);
    updateLocation(currentId.current, id);
    try {
      const data = await requestJson<ThreadData>(`/api/threads?id=${encodeURIComponent(id)}`);
      if (version === threadVersion.current && data.thread.chatId === currentId.current) setThreadData(data);
    } catch (error) {
      if (version === threadVersion.current) { closeThread(); toast.error(errorText(error)); }
    }
  }, [closeThread]);

  const refresh = useCallback(async () => {
    const version = ++loadVersion.current;
    const result = await requestJson<{ chats: Chat[] }>("/api/chats");
    if (version !== loadVersion.current) return;
    setChats(result.chats);
    const id = result.chats.some((chat) => chat.id === currentId.current) ? currentId.current : result.chats[0]?.id;
    currentId.current = id ?? null;
    if (!id) { setCurrent(null); closeThread(); return; }
    const data = await requestJson<ChatData>(`/api/chats?id=${encodeURIComponent(id)}`);
    if (version !== loadVersion.current || id !== currentId.current) return;
    setCurrent(data);
    const selected = threadId.current;
    if (selected && data.threads.some((thread) => thread.id === selected)) {
      const thread = await requestJson<ThreadData>(`/api/threads?id=${encodeURIComponent(selected)}`);
      if (selected === threadId.current && id === currentId.current) setThreadData(thread);
    } else if (selected) closeThread();
    updateLocation(id, threadId.current);
  }, [closeThread]);

  useEffect(() => {
    const listener = () => { void refresh().catch((error) => toast.error(errorText(error))); };
    window.addEventListener("threadllm:refresh", listener);
    return () => window.removeEventListener("threadllm:refresh", listener);
  }, [refresh]);

  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") { event.preventDefault(); showSearch(); return; }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); setSwitcherOpen(true); return; }
      if (event.key !== "Escape" || deleting || switcherOpen) return;
      if (searchOpen) { event.preventDefault(); closeSearch(); }
      else if (threadId.current) { event.preventDefault(); closeThread(); }
      else setMobileOpen(false);
    };
    window.addEventListener("keydown", keyboard);
    return () => window.removeEventListener("keydown", keyboard);
  }, [closeThread, closeSearch, showSearch, searchOpen, switcherOpen, deleting]);

  const selectChat = useCallback(async (id: string) => {
    const version = ++loadVersion.current;
    currentId.current = id;
    closeThread();
    closeSearch();
    setMainFocus(null);
    setThreadFocus(null);
    setMobileOpen(false);
    try {
      const data = await requestJson<ChatData>(`/api/chats?id=${encodeURIComponent(id)}`);
      if (version !== loadVersion.current) return;
      setCurrent(data);
      updateLocation(id, null);
    } catch (error) { toast.error(errorText(error)); }
  }, [closeThread, closeSearch]);

  const newChat = useCallback(async () => {
    try {
      const { chat } = await requestJson<{ chat: Chat }>("/api/chats", { method: "POST" });
      setChats((existing) => [chat, ...existing]);
      await selectChat(chat.id);
    } catch (error) { toast.error(errorText(error)); }
  }, [selectChat]);

  const replyToSelection = useCallback(async (selection: SpanSelection) => {
    try {
      const { thread } = await streamStore.runOperation("Preparing your thread…", (signal) => requestJson<{ thread: Thread }>("/api/threads", {
        method: "POST", signal, body: JSON.stringify({ parentMessageId: selection.parentMessageId, anchorStart: selection.anchorStart, anchorEnd: selection.anchorEnd, source: "user" }),
      }));
      if (thread.chatId !== currentId.current) return;
      setCurrent((data) => data ? { ...data, threads: [...data.threads.filter((item) => item.id !== thread.id), thread] } : data);
      setThreadFocus(null);
      await openThread(thread.id);
    } catch (error) {
      if (!(error instanceof Error && error.name === "AbortError")) toast.error(errorText(error));
    }
  }, [openThread]);

  function openSearchResult(result: SearchResult) {
    const focus = { id: result.id, nonce: ++focusVersion.current };
    setMobileOpen(false);
    if (result.threadId) { setThreadFocus(focus); void openThread(result.threadId); }
    else { closeThread(); setMainFocus(focus); }
  }

  async function resolveThread() {
    if (!threadData || streams.locked) return;
    try {
      const data = await requestJson<ThreadData>(`/api/threads?id=${encodeURIComponent(threadData.thread.id)}`, { method: "PATCH", body: JSON.stringify({ resolved: !threadData.thread.resolved }) });
      if (data.thread.id === threadId.current) setThreadData(data);
      setCurrent((current) => current ? { ...current, threads: current.threads.map((thread) => thread.id === data.thread.id ? data.thread : thread) } : current);
      toast.success(data.thread.resolved ? "Thread resolved." : "Thread reopened.");
    } catch (error) { toast.error(errorText(error)); }
  }

  async function updateContext() {
    if (!threadData) return;
    const id = threadData.thread.id;
    try {
      const data = await streamStore.runOperation("Updating thread context…", (signal) => requestJson<ThreadData>(`/api/threads?id=${encodeURIComponent(id)}`, { method: "PATCH", signal, body: JSON.stringify({ action: "refresh" }) }));
      if (id === threadId.current) setThreadData(data);
      setCurrent((current) => current ? { ...current, threads: current.threads.map((thread) => thread.id === data.thread.id ? data.thread : thread) } : current);
      toast.success("Thread context updated.");
    } catch (error) {
      if (!(error instanceof Error && error.name === "AbortError")) toast.error(errorText(error));
    }
  }

  async function copyToMain(messageId: string) {
    try {
      const { message } = await requestJson<{ message: { id: string; chatId: string } }>("/api/messages", { method: "POST", body: JSON.stringify({ action: "copy-to-main", messageId }) });
      await refresh();
      if (message.chatId === currentId.current) {
        setMainFocus({ id: message.id, nonce: ++focusVersion.current });
        if (narrow) closeThread();
      }
      toast.success("Copied to the main conversation.");
    } catch (error) { toast.error(errorText(error)); }
  }

  async function deleteItem() {
    if (!deleting || streams.locked) return;
    setDeletePending(true);
    try {
      await requestJson(`/api/${deleting.kind === "chat" ? "chats" : "threads"}?id=${encodeURIComponent(deleting.id)}`, { method: "DELETE" });
      if (deleting.kind === "chat" && currentId.current === deleting.id) { currentId.current = null; closeThread(); closeSearch(); }
      if (deleting.kind === "thread" && threadId.current === deleting.id) closeThread();
      setDeleting(null);
      await refresh();
      toast.success(deleting.kind === "chat" ? "Conversation deleted." : "Thread deleted. The original answer is unchanged.");
    } catch (error) { toast.error(errorText(error)); }
    finally { setDeletePending(false); }
  }

  return (
    <div ref={shellRef} className={`app-shell${activeThreadId ? " has-thread" : ""}`} data-theme={theme}>
      <Sidebar chats={chats} currentChatId={current?.chat.id ?? null} threads={current?.threads ?? []} activeThreadId={activeThreadId} onOpenThread={openThread} onChat={selectChat} onNewChat={newChat} onDeleteChat={(chat) => { setMobileOpen(false); setDeleting({ ...chat, kind: "chat" }); }} mobileOpen={mobileOpen} onCloseMobile={() => setMobileOpen(false)} theme={theme} onToggleTheme={toggleTheme} locked={streams.locked} searchOpen={searchOpen} onSearch={showSearch} onSwitcher={() => setSwitcherOpen(true)}>
        {searchOpen && <SearchPanel key={current?.chat.id ?? "empty"} chatId={current?.chat.id ?? null} onClose={closeSearch} onSelect={openSearchResult} />}
      </Sidebar>
      {!narrow && <div className="resize-handle" onMouseDown={(e) => { e.preventDefault(); startResize('sidebar', e.clientX); }} onDoubleClick={() => { setSidebarWidth(220); sidebarWidthRef.current = 220; try { localStorage.removeItem('threadllm:sidebar-width'); } catch {} }} />}
      <main className="main-pane" inert={Boolean(narrow && activeThreadId)}>
        <header className="main-header"><div className="main-title"><Button variant="ghost" size="icon" className="mobile-only" aria-label="Open navigation" onClick={() => setMobileOpen(true)}><Menu /></Button><div><span className="header-eyebrow">Main conversation</span><h1>{current?.chat.title ?? "A fresh page"}</h1></div></div><span className="provider-pill" title={providerStatus.mock ? "Responses are simulated locally. No API key is needed." : "Using your server-side API keys"}><span />{providerStatus.mock ? "Mock mode" : "Live"}</span></header>
        <ProviderBanner status={providerStatus} errorCode={streams.notice?.code} />
        {current && messages.length > 0 ? <MessageList key={current.chat.id} chatId={current.chat.id} threadId={null} messages={messages} threads={current.threads} activeThreadId={activeThreadId} onOpenThread={openThread} session={mainSession} locked={streams.locked} focus={mainFocus} /> : <div className="empty-conversation"><Logo size={46} /><h2>A little room to think.</h2><p>Start with a question. Follow the parts<br />that deserve their own conversation.</p>{!current && <Button variant="outline" onClick={newChat}><Plus size={16} />Start a conversation</Button>}</div>}
        {current && <Composer key={`composer:${current.chat.id}`} chatId={current.chat.id} threadId={null} messages={messages} disabled={unavailable} focusOnMount={messages.length === 0} providerStatus={providerStatus} />}
      </main>
      {!narrow && activeThreadId && <div className="resize-handle" onMouseDown={(e) => { e.preventDefault(); startResize('thread', e.clientX); }} onDoubleClick={() => { setThreadWidth(340); threadWidthRef.current = 340; try { localStorage.removeItem('threadllm:thread-width'); } catch {} }} />}
      <div className={`thread-shell${activeThreadId ? " is-open" : ""}`}>{activeThreadId && <ThreadPanel key={activeThreadId} id={activeThreadId} data={threadData} narrow={narrow} unavailable={unavailable} providerStatus={providerStatus} errorCode={streams.notice?.code} onClose={closeThread} onResolve={resolveThread} onRefreshContext={updateContext} focus={threadFocus} onCopyToMain={copyToMain} onDelete={() => { if (threadData) setDeleting({ kind: "thread", id: threadData.thread.id, title: threadData.thread.title }); }} />}</div>
      <SelectionReply messages={messages} locked={streams.locked || unavailable || switcherOpen || Boolean(deleting)} onReply={replyToSelection} />
      {switcherOpen && <ChatSwitcher chats={chats} currentChatId={current?.chat.id ?? null} onClose={() => setSwitcherOpen(false)} onSelect={selectChat} onNewChat={newChat} />}
      <Dialog open={Boolean(deleting)} onOpenChange={(open) => { if (!open && !deletePending) setDeleting(null); }}><DialogContent><DialogHeader><DialogTitle>{deleting?.kind === "thread" ? "Delete this thread?" : "Delete this conversation?"}</DialogTitle><DialogDescription>“{deleting?.title}” {deleting?.kind === "thread" ? "and its messages will be deleted. The original answer stays unchanged." : "and all of its threads and messages will be permanently deleted."}</DialogDescription></DialogHeader><div className="dialog-actions"><Button variant="ghost" onClick={() => setDeleting(null)} disabled={deletePending}>Keep {deleting?.kind === "thread" ? "thread" : "conversation"}</Button><Button variant="destructive" onClick={() => void deleteItem()} disabled={deletePending || streams.locked}>{deletePending ? "Deleting…" : `Delete ${deleting?.kind === "thread" ? "thread" : "conversation"}`}</Button></div></DialogContent></Dialog>
      <Toaster theme={theme} position="top-right" toastOptions={{ className: "margin-toast" }} />
    </div>
  );
}
