"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Menu, Pencil, Plus } from "lucide-react";
import { ProviderBanner } from "./provider-banner";
import { GuestSession } from "./guest-session";
import { Toaster, toast } from "sonner";
import { chatCache } from "@/lib/chat-cache";
import { requestJson, errorText } from "@/lib/client-api";
import { bindClientUser, clearPrivateClientState } from "@/lib/client-state";
import { mergeMessages } from "@/lib/merge-messages";
import { useThemePreference } from "@/lib/preferences";
import { scopeKey, streamStore, useStreams } from "@/lib/stream-store";
import { useNarrowScreen } from "@/lib/use-narrow-screen";
import type { AppData, Chat, ChatData, Folder, ProviderStatus, SearchResult, Thread, ThreadData } from "@/lib/types";
import { Sidebar } from "./sidebar";
import { SearchPanel } from "./search-panel";
import { ChatSwitcher } from "./chat-switcher";
import { MoveToDialog } from "./move-to-dialog";
import { NameDialog } from "./name-dialog";
import { Composer } from "./composer";
import { MessageList, type MessageFocus } from "./message-list";
import { SelectionReply, type SpanSelection } from "./selection-reply";
import { ThreadPanel } from "./thread-panel";
import { Logo } from "./logo";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";

type DeleteTarget = { kind: "chat" | "thread" | "folder"; id: string; title: string };
type NameTarget = { kind: "chat"; chat: Chat } | { kind: "folder"; folder: Folder } | { kind: "new-folder"; parentId: string | null };

function updateLocation(chatId: string | null, threadId: string | null) {
  const params = new URLSearchParams();
  if (chatId) params.set("chat", chatId);
  if (threadId) params.set("thread", threadId);
  window.history.replaceState(null, "", `${window.location.pathname}${params.size ? `?${params}` : ""}`);
}

function EditableTitle({ title, disabled, onRename }: { title: string; disabled: boolean; onRename: () => void }) {
  return <div className="editable-title-wrap">
    <span className="header-eyebrow">Main conversation</span>
    <h1><button className="editable-title" disabled={disabled} onClick={onRename} aria-label={`Rename conversation: ${title}`} title="Rename conversation"><span>{title}</span>{!disabled && <Pencil size={12} />}</button></h1>
  </div>;
}

export interface ClientUser {
  id: string;
  email: string | null;
  isGuest?: boolean;
  guestExpiresAt?: number;
}

export function ChatApp({ initialData, providerStatus, initialThread = null, user, missingChat = false }: { initialData: AppData; providerStatus: ProviderStatus; initialThread?: ThreadData | null; user: ClientUser; missingChat?: boolean }) {
  useState(() => {
    bindClientUser(user.id);
    if (initialData.current) chatCache.setChat(initialData.current);
    if (initialThread) chatCache.setThread(initialThread);
    return true;
  });
  const [chats, setChats] = useState(initialData.chats);
  const [folders, setFolders] = useState(initialData.folders);
  const [current, setCurrent] = useState(initialData.current);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(initialThread?.thread.id ?? null);
  const [threadData, setThreadData] = useState(initialThread);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [movingChatId, setMovingChatId] = useState<string | null>(null);
  const [movingFolderId, setMovingFolderId] = useState<string | null>(null);
  const [mainFocus, setMainFocus] = useState<MessageFocus | null>(null);
  const [threadFocus, setThreadFocus] = useState<MessageFocus | null>(null);
  const [deleting, setDeleting] = useState<DeleteTarget | null>(null);
  const [naming, setNaming] = useState<NameTarget | null>(null);
  const [deletePending, setDeletePending] = useState(false);
  const [restoringDemo, setRestoringDemo] = useState(false);
  const [threadPending, setThreadPending] = useState(false);
  const [loadingChatId, setLoadingChatId] = useState<string | null>(null);
  const threadPendingRef = useRef(false);
  const currentId = useRef(current?.chat.id ?? null);
  const threadId = useRef(activeThreadId);
  const loadVersion = useRef(0);
  const threadVersion = useRef(0);
  const focusVersion = useRef(0);
  const returnFocus = useRef<HTMLElement | null>(null);
  const [theme, toggleTheme] = useThemePreference();
  const narrow = useNarrowScreen();
  const sidebarWidthRef = useRef(220);
  const threadWidthRef = useRef(340);
  const shellRef = useRef<HTMLDivElement>(null);
  const streams = useStreams();
  const mainSession = current ? streams.sessions.get(scopeKey(current.chat.id, null)) : undefined;
  const messages = useMemo(() => current ? mergeMessages(current.messages, mainSession, current.chat.id) : [], [current, mainSession]);
  const unavailable = !providerStatus.mock && (!providerStatus.deepseek && !providerStatus.anthropic && !providerStatus.openai);

  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
  useEffect(() => {
    if (!missingChat) return;
    updateLocation(currentId.current, null);
    toast.error("That conversation no longer exists.");
  }, [missingChat]);
  useEffect(() => {
    if (streams.notice && !streams.notice.messageId) toast.error(streams.notice.message);
  }, [streams.notice]);

  useLayoutEffect(() => {
    try {
      const sw = Number(localStorage.getItem('threads:sidebar-width'));
      const tw = Number(localStorage.getItem('threads:thread-width'));
      if (sw >= 160 && sw <= 400) sidebarWidthRef.current = sw;
      if (tw >= 260 && tw <= 600) threadWidthRef.current = tw;
    } catch {}
    shellRef.current?.style.setProperty('--sidebar-width', `${sidebarWidthRef.current}px`);
    shellRef.current?.style.setProperty('--thread-width', `${threadWidthRef.current}px`);
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
      try {
        localStorage.setItem('threads:sidebar-width', String(sidebarWidthRef.current));
        localStorage.setItem('threads:thread-width', String(threadWidthRef.current));
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
    threadPendingRef.current = false;
    setThreadPending(false);
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
    const cached = chatCache.getThread(id);
    setThreadData((existing) => existing?.thread.id === id ? existing : cached?.thread.chatId === currentId.current ? cached : null);
    setMobileOpen(false);
    updateLocation(currentId.current, id);
    try {
      const data = await requestJson<ThreadData>(`/api/threads?id=${encodeURIComponent(id)}`);
      chatCache.setThread(data);
      if (version === threadVersion.current && data.thread.chatId === currentId.current) setThreadData(data);
    } catch (error) {
      if (version === threadVersion.current) { closeThread(); toast.error(errorText(error)); }
    }
  }, [closeThread]);

  /** Applies an authoritative chat view: current pane, cache, and the library entry (title, folder). */
  const applyChat = useCallback((data: ChatData) => {
    chatCache.setChat(data);
    setChats((existing) => existing.some((chat) => chat.id === data.chat.id)
      ? existing.map((chat) => chat.id === data.chat.id ? data.chat : chat)
      : [data.chat, ...existing]);
    if (data.chat.id === currentId.current) setCurrent(data);
  }, []);

  /** Revalidates one chat (and its open thread) in parallel; other views are left alone. */
  const refreshScope = useCallback(async (scope: { chatId: string; threadId: string | null }) => {
    const version = loadVersion.current;
    const selected = threadId.current;
    const wantThread = scope.threadId ?? (selected && scope.chatId === currentId.current ? selected : null);
    const [chatResult, threadResult] = await Promise.allSettled([
      requestJson<ChatData>(`/api/chats?id=${encodeURIComponent(scope.chatId)}`),
      wantThread ? requestJson<ThreadData>(`/api/threads?id=${encodeURIComponent(wantThread)}`) : Promise.resolve(null),
    ]);
    if (chatResult.status === "fulfilled") {
      if (version === loadVersion.current) applyChat(chatResult.value);
    } else if (chatResult.reason instanceof Error && "status" in chatResult.reason && chatResult.reason.status === 404) {
      chatCache.dropChat(scope.chatId);
      setChats((existing) => existing.filter((chat) => chat.id !== scope.chatId));
      if (scope.chatId === currentId.current && version === loadVersion.current) { currentId.current = null; setCurrent(null); closeThread(); }
    } else throw chatResult.reason;
    if (threadResult.status === "fulfilled" && threadResult.value) {
      chatCache.setThread(threadResult.value);
      if (threadResult.value.thread.id === threadId.current && version === loadVersion.current) setThreadData(threadResult.value);
    } else if (threadResult.status === "rejected" && wantThread) {
      chatCache.dropThread(wantThread);
      if (wantThread === threadId.current) closeThread();
    }
  }, [applyChat, closeThread]);

  /** Full reconciliation with committed server state (library plus the current view). */
  const refresh = useCallback(async () => {
    const version = ++loadVersion.current;
    const result = await requestJson<{ chats: Chat[]; folders: Folder[] }>("/api/chats");
    if (version !== loadVersion.current) return;
    setChats(result.chats);
    setFolders(result.folders);
    const id = result.chats.some((chat) => chat.id === currentId.current) ? currentId.current : result.chats[0]?.id;
    currentId.current = id ?? null;
    if (!id) { setCurrent(null); closeThread(); return; }
    await refreshScope({ chatId: id, threadId: null });
    if (version !== loadVersion.current) return;
    if (threadId.current && !chatCache.getThread(threadId.current)) closeThread();
    updateLocation(id, threadId.current);
  }, [closeThread, refreshScope]);

  useEffect(() => {
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<{ chatId: string; threadId: string | null } | undefined>).detail;
      const task = detail ? refreshScope(detail) : refresh();
      void task.catch((error) => toast.error(errorText(error)));
    };
    const visible = () => {
      if (document.visibilityState === "visible" && currentId.current) void refreshScope({ chatId: currentId.current, threadId: null }).catch(() => undefined);
    };
    window.addEventListener("threads:refresh", listener);
    document.addEventListener("visibilitychange", visible);
    return () => {
      window.removeEventListener("threads:refresh", listener);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [refresh, refreshScope]);

  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") { event.preventDefault(); showSearch(); return; }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); setSwitcherOpen(true); return; }
      if (event.key !== "Escape" || deleting || naming || switcherOpen || movingChatId || movingFolderId) return;
      if (searchOpen) { event.preventDefault(); closeSearch(); }
      else if (threadId.current || threadPendingRef.current) { event.preventDefault(); closeThread(); }
      else setMobileOpen(false);
    };
    window.addEventListener("keydown", keyboard);
    return () => window.removeEventListener("keydown", keyboard);
  }, [closeThread, closeSearch, showSearch, searchOpen, switcherOpen, deleting, naming, movingChatId, movingFolderId]);

  const selectChat = useCallback(async (id: string) => {
    const version = ++loadVersion.current;
    currentId.current = id;
    closeThread();
    closeSearch();
    setMainFocus(null);
    setThreadFocus(null);
    setMobileOpen(false);
    const cached = chatCache.getChat(id);
    const known = chats.find((chat) => chat.id === id);
    // Cached content appears immediately; otherwise show the shell for that chat while it loads.
    if (cached) setCurrent(cached);
    else if (known) { setCurrent({ chat: known, messages: [], threads: [] }); setLoadingChatId(id); }
    updateLocation(id, null);
    try {
      const data = await requestJson<ChatData>(`/api/chats?id=${encodeURIComponent(id)}`);
      if (version !== loadVersion.current) return;
      applyChat(data);
    } catch (error) { toast.error(errorText(error)); }
    finally { if (version === loadVersion.current) setLoadingChatId(null); }
  }, [applyChat, chats, closeThread, closeSearch]);

  const newChat = useCallback(async (folderId: string | null = null) => {
    try {
      const { chat } = await requestJson<{ chat: Chat }>("/api/chats", { method: "POST", body: JSON.stringify({ folderId }) });
      setChats((existing) => [chat, ...existing]);
      chatCache.setChat({ chat, messages: [], threads: [] });
      await selectChat(chat.id);
    } catch (error) { toast.error(errorText(error)); }
  }, [selectChat]);

  const createFolder = useCallback(async (name: string, parentId: string | null = null) => {
    const { folder } = await requestJson<{ folder: Folder }>("/api/folders", { method: "POST", body: JSON.stringify({ name, parentId }) });
    setFolders((existing) => [...existing, folder]);
    return folder;
  }, []);

  const renameFolder = useCallback(async (id: string, name: string) => {
    const { folder } = await requestJson<{ folder: Folder }>(`/api/folders?id=${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ name }) });
    setFolders((existing) => existing.map((item) => item.id === folder.id ? folder : item));
  }, []);

  const moveFolder = useCallback(async (id: string, parentId: string | null) => {
    const { folder } = await requestJson<{ folder: Folder }>(`/api/folders?id=${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ parentId }) });
    setFolders((existing) => existing.map((item) => item.id === folder.id ? folder : item));
  }, []);

  const renameChat = useCallback(async (chatId: string, title: string) => {
    const { chat } = await requestJson<{ chat: Chat }>(`/api/chats?id=${encodeURIComponent(chatId)}`, { method: "PATCH", body: JSON.stringify({ title }) });
    setChats((existing) => existing.map((item) => item.id === chat.id ? chat : item));
    setCurrent((data) => data?.chat.id === chat.id ? { ...data, chat } : data);
  }, []);

  const renameThread = useCallback(async (threadId: string, title: string) => {
    try {
      const data = await requestJson<ThreadData>(`/api/threads?id=${encodeURIComponent(threadId)}`, { method: "PATCH", body: JSON.stringify({ title }) });
      chatCache.setThread(data);
      if (data.thread.id === threadId) setThreadData((existing) => existing?.thread.id === data.thread.id ? data : existing);
      setCurrent((cur) => cur ? { ...cur, threads: cur.threads.map((t) => t.id === data.thread.id ? data.thread : t) } : cur);
    } catch (error) { toast.error(errorText(error)); }
  }, []);

  const moveChat = useCallback(async (chatId: string, folderId: string | null) => {
    const { chat } = await requestJson<{ chat: Chat }>(`/api/chats?id=${encodeURIComponent(chatId)}`, { method: "PATCH", body: JSON.stringify({ folderId }) });
    setChats((existing) => existing.map((item) => item.id === chat.id ? chat : item));
    setCurrent((data) => data?.chat.id === chat.id ? { ...data, chat } : data);
  }, []);

  const replyToSelection = useCallback(async (selection: SpanSelection) => {
    threadPendingRef.current = true;
    setThreadPending(true);
    setThreadFocus(null);
    setMobileOpen(false);
    try {
      const { thread } = await streamStore.runOperation("Preparing your thread…", (signal) => requestJson<{ thread: Thread }>("/api/threads", {
        method: "POST", signal, body: JSON.stringify({ parentMessageId: selection.parentMessageId, anchorStart: selection.anchorStart, anchorEnd: selection.anchorEnd, source: "user" }),
      }));
      const openWhenReady = threadPendingRef.current;
      threadPendingRef.current = false;
      setThreadPending(false);
      if (thread.chatId !== currentId.current) return;
      setCurrent((data) => data ? { ...data, threads: [...data.threads.filter((item) => item.id !== thread.id), thread] } : data);
      if (openWhenReady) await openThread(thread.id);
    } catch (error) {
      threadPendingRef.current = false;
      setThreadPending(false);
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
      chatCache.setThread(data);
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
      chatCache.setThread(data);
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
      await refreshScope({ chatId: message.chatId, threadId: null });
      if (message.chatId === currentId.current) {
        setMainFocus({ id: message.id, nonce: ++focusVersion.current });
        if (narrow) closeThread();
      }
      toast.success("Copied to the main conversation.");
    } catch (error) { toast.error(errorText(error)); }
  }

  async function restoreDemo() {
    if (restoringDemo || streams.locked) return;
    setRestoringDemo(true);
    try {
      const result = await requestJson<{ addedFolders: number; addedChats: number }>("/api/demo", { method: "POST", body: JSON.stringify({ action: "restore" }) });
      await refresh();
      toast.success(result.addedFolders || result.addedChats ? "Demo library restored. Existing conversations were kept." : "All demo folders and chats are already present.");
    } catch (error) { toast.error(errorText(error)); }
    finally { setRestoringDemo(false); }
  }

  async function saveName(name: string) {
    if (naming?.kind === "chat") await renameChat(naming.chat.id, name);
    else if (naming?.kind === "folder") await renameFolder(naming.folder.id, name);
    else if (naming?.kind === "new-folder") await createFolder(name, naming.parentId);
  }

  async function deleteItem() {
    if (!deleting || streams.locked) return;
    setDeletePending(true);
    try {
      const resource = deleting.kind === "chat" ? "chats" : deleting.kind === "folder" ? "folders" : "threads";
      await requestJson(`/api/${resource}?id=${encodeURIComponent(deleting.id)}`, { method: "DELETE" });
      if (deleting.kind === "chat") chatCache.dropChat(deleting.id);
      if (deleting.kind === "thread") chatCache.dropThread(deleting.id);
      if (deleting.kind === "chat" && currentId.current === deleting.id) { currentId.current = null; closeThread(); closeSearch(); }
      if (deleting.kind === "thread" && threadId.current === deleting.id) closeThread();
      setDeleting(null);
      if (deleting.kind === "thread" && currentId.current) await refreshScope({ chatId: currentId.current, threadId: null });
      else await refresh();
      toast.success(deleting.kind === "chat" ? "Conversation deleted." : deleting.kind === "folder" ? "Folder deleted. Conversations moved to Unsorted." : "Thread deleted. The original answer is unchanged.");
    } catch (error) { toast.error(errorText(error)); }
    finally { setDeletePending(false); }
  }

  async function signOut() {
    streamStore.stopAll();
    try {
      const response = await fetch("/auth/signout", { method: "POST", headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error("Sign-out failed");
    } catch {
      if (user.isGuest) {
        toast.error("Could not end your guest session. Please try again; automatic deletion is still scheduled.");
        return;
      }
    }
    clearPrivateClientState();
    window.location.replace("/login");
  }

  const movingChat = movingChatId ? chats.find((chat) => chat.id === movingChatId) : null;
  const loadingCurrent = current !== null && loadingChatId === current.chat.id && current.messages.length === 0;
  const threadOpen = activeThreadId !== null || threadPending;
  const nameKind = naming?.kind === "chat" ? "conversation" : "folder";
  const deletingLabel = deleting?.kind === "chat" ? "conversation" : deleting?.kind ?? "conversation";

  return (
    <div ref={shellRef} className={`app-shell${threadOpen ? " has-thread" : ""}`} data-theme={theme}>
      <Sidebar chats={chats} folders={folders} currentChatId={current?.chat.id ?? null} threads={current?.threads ?? []} activeThreadId={activeThreadId}
        onOpenThread={openThread} onChat={selectChat} onNewChat={() => void newChat()}
        onDeleteChat={(chat) => { setMobileOpen(false); setDeleting({ ...chat, kind: "chat" }); }}
        onMoveChat={(chatId) => { setMobileOpen(false); setMovingChatId(chatId); }}
        onRenameChat={(chat) => setNaming({ kind: "chat", chat })}
        onRenameFolder={(folder) => setNaming({ kind: "folder", folder })}
        onCreateFolder={(parentId) => setNaming({ kind: "new-folder", parentId })}
        onDeleteFolder={(id) => { setMobileOpen(false); setDeleting({ kind: "folder", id, title: folders.find((folder) => folder.id === id)?.name ?? "Folder" }); }}
        onMoveFolder={(id) => { setMobileOpen(false); setMovingFolderId(id); }}
        onDropChat={(chatId, folderId) => void moveChat(chatId, folderId).catch((error) => toast.error(errorText(error)))}
        onRenameThread={(id, title) => void renameThread(id, title)}
        onDeleteThread={(thread) => { setMobileOpen(false); setDeleting({ ...thread, kind: "thread" }); }}
        mobileOpen={mobileOpen} onCloseMobile={() => setMobileOpen(false)} theme={theme} onToggleTheme={toggleTheme} locked={streams.locked} searchOpen={searchOpen} onSearch={showSearch} onSwitcher={() => setSwitcherOpen(true)}
        userEmail={user.email} onSignOut={() => void signOut()}>
        {searchOpen && <SearchPanel key={current?.chat.id ?? "empty"} chatId={current?.chat.id ?? null} onClose={closeSearch} onSelect={openSearchResult} />}
      </Sidebar>
      {!narrow && <div className="resize-handle" onMouseDown={(e) => { e.preventDefault(); startResize('sidebar', e.clientX); }} onDoubleClick={() => { shellRef.current?.style.setProperty('--sidebar-width', '220px'); sidebarWidthRef.current = 220; try { localStorage.removeItem('threads:sidebar-width'); } catch {} }} />}
      <main className="main-pane" inert={Boolean(narrow && threadOpen)}>
        {user.guestExpiresAt && <GuestSession expiresAt={user.guestExpiresAt} onEnd={signOut} />}
        <header className="main-header"><div className="main-title"><Button variant="ghost" size="icon" className="mobile-only" aria-label="Open navigation" onClick={() => setMobileOpen(true)}><Menu /></Button><EditableTitle title={current?.chat.title ?? "A fresh page"} disabled={!current} onRename={() => { if (current) setNaming({ kind: "chat", chat: current.chat }); }} /></div>{current?.chat.demoKey && <span className="demo-chat-badge" title="Prewritten study history. Your own follow-ups are saved normally.">Study demo</span>}</header>
        <ProviderBanner status={providerStatus} errorCode={streams.notice?.code} />
        {loadingCurrent ? <div className="conversation-skeleton" aria-busy="true" aria-label="Loading conversation"><div className="skeleton-line w-2/3" /><div className="skeleton-line" /><div className="skeleton-line w-5/6" /><div className="skeleton-line w-1/2" /></div>
          : current && messages.length > 0 ? <MessageList key={current.chat.id} chatId={current.chat.id} threadId={null} messages={messages} threads={current.threads} activeThreadId={activeThreadId} onOpenThread={openThread} session={mainSession} locked={streams.locked} focus={mainFocus} /> : <div className="empty-conversation"><Logo size={46} /><h2>A little room to think.</h2><p>Start with a question. Follow the parts<br />that deserve their own thread.</p>{!current && <Button variant="outline" onClick={() => void newChat()}><Plus size={16} />Start a conversation</Button>}</div>}
        {current && <Composer key={`composer:${current.chat.id}`} chatId={current.chat.id} threadId={null} messages={messages} disabled={unavailable} focusOnMount={messages.length === 0} providerStatus={providerStatus} />}
      </main>
      {!narrow && threadOpen && <div className="resize-handle" onMouseDown={(e) => { e.preventDefault(); startResize('thread', e.clientX); }} onDoubleClick={() => { shellRef.current?.style.setProperty('--thread-width', '340px'); threadWidthRef.current = 340; try { localStorage.removeItem('threads:thread-width'); } catch {} }} />}
      <div className={`thread-shell${threadOpen ? " is-open" : ""}`}>{threadOpen && <ThreadPanel key={activeThreadId ?? "pending"} id={activeThreadId ?? "pending"} data={activeThreadId ? threadData : null} narrow={narrow} unavailable={unavailable} providerStatus={providerStatus} errorCode={streams.notice?.code} onClose={closeThread} onResolve={resolveThread} onRefreshContext={updateContext} focus={threadFocus} onCopyToMain={copyToMain} onDelete={() => { if (threadData) setDeleting({ kind: "thread", id: threadData.thread.id, title: threadData.thread.title }); }} />}</div>
      <SelectionReply messages={messages} locked={streams.locked || unavailable || switcherOpen || Boolean(deleting) || Boolean(naming) || Boolean(movingChatId) || Boolean(movingFolderId)} onReply={replyToSelection} />
      {switcherOpen && <ChatSwitcher chats={chats} folders={folders} currentChatId={current?.chat.id ?? null} onClose={() => setSwitcherOpen(false)} onSelect={selectChat} onNewChat={newChat}
        onRestoreDemo={() => void restoreDemo()} restoringDemo={restoringDemo} restoreDisabled={streams.locked}
        onCreateFolder={(parentId) => setNaming({ kind: "new-folder", parentId })}
        onRenameChat={(chat) => setNaming({ kind: "chat", chat })} onRenameFolder={(folder) => setNaming({ kind: "folder", folder })}
        onMoveChat={(chatId, folderId) => void moveChat(chatId, folderId).catch((error) => toast.error(errorText(error)))} />}
      {movingChat && <MoveToDialog folders={folders} currentFolderId={movingChat.folderId} onMove={(folderId) => moveChat(movingChat.id, folderId)} onCreateFolder={createFolder} onClose={() => setMovingChatId(null)} />}
      {movingFolderId && <MoveToDialog itemType="folder" folders={folders.filter((folder) => { let id: string | null = folder.id; while (id) { if (id === movingFolderId) return false; const parent = folders.find((item) => item.id === id); id = parent?.parentId ?? null; } return true; })}
        currentFolderId={folders.find((folder) => folder.id === movingFolderId)?.parentId ?? null} onMove={(folderId) => moveFolder(movingFolderId, folderId)} onCreateFolder={createFolder} onClose={() => setMovingFolderId(null)} />}
      {naming && <NameDialog title={naming.kind === "new-folder" ? "New folder" : `Rename ${nameKind}`} label={nameKind === "conversation" ? "Conversation name" : "Folder name"}
        description={naming.kind === "new-folder" ? `Create a folder in ${folders.find((folder) => folder.id === naming.parentId)?.name ?? "Library"}.` : `Give this ${nameKind} a name that's easy to find. Its contents will stay unchanged.`}
        initialValue={naming.kind === "chat" ? naming.chat.title : naming.kind === "folder" ? naming.folder.name : ""}
        submitLabel={naming.kind === "new-folder" ? "Create folder" : "Save name"} onSave={saveName} onClose={() => setNaming(null)} />}
      <Dialog open={Boolean(deleting)} onOpenChange={(open) => { if (!open && !deletePending) setDeleting(null); }}>
        <DialogContent><DialogHeader><DialogTitle>Delete this {deletingLabel}?</DialogTitle><DialogDescription>&ldquo;{deleting?.title}&rdquo; {deleting?.kind === "folder" ? "and its subfolders will be deleted. Conversations inside will be kept in Unsorted." : deleting?.kind === "thread" ? "and its messages will be deleted. The original answer stays unchanged." : "and all of its threads and messages will be permanently deleted."}</DialogDescription></DialogHeader>
          <div className="dialog-actions"><Button variant="ghost" onClick={() => setDeleting(null)} disabled={deletePending}>Keep {deletingLabel}</Button><Button variant="destructive" onClick={() => void deleteItem()} disabled={deletePending || streams.locked}>{deletePending ? "Deleting…" : `Delete ${deletingLabel}`}</Button></div>
        </DialogContent>
      </Dialog>
      <Toaster theme={theme} position="top-right" toastOptions={{ className: "threads-toast" }} />
    </div>
  );
}
