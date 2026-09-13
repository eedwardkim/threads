"use client";

import { useState, useRef, useEffect, useId, type CSSProperties, type DragEvent, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronRight, Ellipsis, FolderIcon, FolderInput, FolderOpen, FolderPlus, Library, MessageSquare, Moon, Pencil, Plus, Search, Sun, TextQuote, Trash2, X } from "lucide-react";
import type { Chat, Folder, Thread } from "@/lib/types";
import { DEMO_FOLDERS } from "@/lib/demo-catalog";
import { CHAT_DRAG_MIME, isChatDrag, setChatDragImage } from "@/lib/drag-ghost";
import { Button } from "./ui/button";
import { Logo } from "./logo";

function ItemMenu({ label, onRename, onMove, onCreateFolder, onDelete, locked = false }: {
  label: string;
  onRename: () => void;
  onMove?: () => void;
  onCreateFolder?: () => void;
  onDelete: () => void;
  locked?: boolean;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<CSSProperties>({});
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const outside = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node) && !triggerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const close = () => setOpen(false);
    document.addEventListener("pointerdown", outside);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [open]);

  function choose(action?: () => void) {
    setOpen(false);
    triggerRef.current?.focus();
    action?.();
  }

  function keyboard(event: KeyboardEvent<HTMLDivElement>) {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const buttons = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Tab") { choose(); return; }
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    } else if (event.key === "Escape" || event.key.toLowerCase() === "r" || (event.key.toLowerCase() === "d" && !locked)) {
      event.preventDefault();
      event.stopPropagation();
      choose(event.key === "Escape" ? undefined : event.key.toLowerCase() === "r" ? onRename : onDelete);
    }
  }

  return <div className="chat-menu-wrap">
    <button ref={triggerRef} className="chat-menu-trigger" aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={() => {
        const rect = triggerRef.current!.getBoundingClientRect();
        setPosition({ left: Math.max(8, Math.min(rect.right - 184, window.innerWidth - 192)), ...(rect.bottom + 190 > window.innerHeight ? { bottom: window.innerHeight - rect.top + 4 } : { top: rect.bottom + 4 }) });
        setOpen(!open);
      }}><Ellipsis size={15} /></button>
    {open && createPortal(<div ref={menuRef} id={id} role="menu" aria-label={label} className="chat-context-menu" style={position} onKeyDown={keyboard}>
      <button role="menuitem" tabIndex={-1} onClick={() => choose(onRename)}><Pencil size={13} /><span>Rename</span><kbd>R</kbd></button>
      {onMove && <button role="menuitem" tabIndex={-1} onClick={() => choose(onMove)}><FolderInput size={13} /><span>Move to…</span></button>}
      {onCreateFolder && <button role="menuitem" tabIndex={-1} onClick={() => choose(onCreateFolder)}><FolderPlus size={13} /><span>New subfolder</span></button>}
      <hr />
      <button role="menuitem" tabIndex={-1} className="destructive" disabled={locked} onClick={() => choose(onDelete)}><Trash2 size={13} /><span>Delete</span><kbd>D</kbd></button>
    </div>, document.body)}
  </div>;
}

type ChatActions = {
  currentChatId: string | null;
  onChat: (id: string) => void;
  onDeleteChat: (chat: Chat) => void;
  onMoveChat: (chatId: string) => void;
  onRenameChat: (chat: Chat) => void;
  onDropChat: (chatId: string, folderId: string | null) => void;
  locked: boolean;
};

type FolderActions = {
  onRenameFolder: (folder: Folder) => void;
  onDeleteFolder: (id: string) => void;
  onMoveFolder: (id: string) => void;
  onCreateFolder: (parentId: string | null) => void;
};

function FolderNode({ folder, folders, chats, ...actions }: { folder: Folder; folders: Folder[]; chats: Chat[] } & ChatActions & FolderActions) {
  const [expanded, setExpanded] = useState(() => !DEMO_FOLDERS.some((item) => item.id === folder.id));
  const [dropHover, setDropHover] = useState(false);
  const expandTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const children = folders.filter((child) => child.parentId === folder.id);
  const folderChats = chats.filter((chat) => chat.folderId === folder.id);
  const count = children.length + folderChats.length;
  const contentsId = useId();

  useEffect(() => () => { if (expandTimer.current) clearTimeout(expandTimer.current); }, []);

  function clearExpandTimer() {
    if (expandTimer.current) { clearTimeout(expandTimer.current); expandTimer.current = null; }
  }

  function dragOver(event: DragEvent) {
    if (!isChatDrag(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    setDropHover(true);
    if (!expanded && !expandTimer.current) {
      expandTimer.current = setTimeout(() => { expandTimer.current = null; setExpanded(true); }, 550);
    }
  }

  function dragLeave(event: DragEvent) {
    event.stopPropagation();
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
    setDropHover(false);
    clearExpandTimer();
  }

  function drop(event: DragEvent) {
    if (!isChatDrag(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    setDropHover(false);
    clearExpandTimer();
    const chatId = event.dataTransfer.getData(CHAT_DRAG_MIME) || event.dataTransfer.getData("text/plain");
    if (chatId) actions.onDropChat(chatId, folder.id);
  }

  return <div className="folder-node">
    <div className={`folder-row${expanded ? " is-expanded" : ""}${dropHover ? " is-drop-target" : ""}`} onDragOver={dragOver} onDragLeave={dragLeave} onDrop={drop}>
      <button className="folder-toggle" onClick={() => setExpanded(!expanded)} aria-label={`${expanded ? "Collapse" : "Expand"} folder: ${folder.name}`} aria-expanded={expanded} aria-controls={contentsId}>
        <ChevronRight size={12} className={`folder-chevron${expanded ? " is-expanded" : ""}`} />
      </button>
      <button className="folder-label" title={folder.name} onClick={() => setExpanded(!expanded)} aria-expanded={expanded} aria-controls={contentsId}
        onKeyDown={(event) => { if (event.key === "F2") { event.preventDefault(); actions.onRenameFolder(folder); } }}>
        {expanded ? <FolderOpen size={15} /> : <FolderIcon size={15} />}<span>{folder.name}</span>
      </button>
      <span className="folder-count" aria-label={`${count} item${count === 1 ? "" : "s"}`}>{count}</span>
      <ItemMenu label={`Folder options: ${folder.name}`} onRename={() => actions.onRenameFolder(folder)} onMove={() => actions.onMoveFolder(folder.id)} onCreateFolder={() => actions.onCreateFolder(folder.id)} onDelete={() => actions.onDeleteFolder(folder.id)} locked={actions.locked} />
    </div>
    {expanded && <div id={contentsId} className="folder-children" onDragOver={dragOver} onDragLeave={dragLeave} onDrop={drop}>
      {children.map((child) => <FolderNode key={child.id} folder={child} folders={folders} chats={chats} {...actions} />)}
      {folderChats.map((chat) => <ChatRow key={chat.id} chat={chat} {...actions} />)}
      {!count && <div className="folder-empty">Drop conversations here</div>}
    </div>}
  </div>;
}

function ChatRow({ chat, currentChatId, onChat, onDeleteChat, onMoveChat, onRenameChat, onDropChat, locked }: { chat: Chat } & ChatActions) {
  const [dropHover, setDropHover] = useState(false);
  const [dragging, setDragging] = useState(false);
  const dragCleanup = useRef<(() => void) | null>(null);

  useEffect(() => () => dragCleanup.current?.(), []);

  return <div className={`chat-list-row${currentChatId === chat.id ? " is-current" : ""}${dropHover ? " is-drop-target" : ""}${dragging ? " is-drag-source" : ""}`}
    draggable onDragStart={(event) => {
      if ((event.target as HTMLElement).closest(".chat-menu-wrap")) { event.preventDefault(); return; }
      event.dataTransfer.setData(CHAT_DRAG_MIME, chat.id);
      event.dataTransfer.setData("text/plain", chat.id);
      event.dataTransfer.effectAllowed = "move";
      dragCleanup.current?.();
      dragCleanup.current = setChatDragImage(event.dataTransfer, chat.title);
      setDragging(true);
    }} onDragEnd={() => { setDragging(false); dragCleanup.current?.(); dragCleanup.current = null; }}
    onDragOver={(event) => {
      if (!isChatDrag(event.dataTransfer)) return;
      event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "move"; setDropHover(true);
    }} onDragLeave={(event) => {
      event.stopPropagation();
      if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) setDropHover(false);
    }} onDrop={(event) => {
      if (!isChatDrag(event.dataTransfer)) return;
      event.preventDefault(); event.stopPropagation(); setDropHover(false);
      const id = event.dataTransfer.getData(CHAT_DRAG_MIME) || event.dataTransfer.getData("text/plain");
      if (id && id !== chat.id) onDropChat(id, chat.folderId);
    }}>
    <button className="chat-link" title={chat.title} aria-current={currentChatId === chat.id ? "page" : undefined} onClick={() => onChat(chat.id)}
      onKeyDown={(event) => { if (event.key === "F2") { event.preventDefault(); onRenameChat(chat); } }}><MessageSquare size={15} /><span>{chat.title}</span></button>
    <ItemMenu label={`Conversation options: ${chat.title}`} onRename={() => onRenameChat(chat)} onMove={() => onMoveChat(chat.id)} onDelete={() => onDeleteChat(chat)} locked={locked} />
  </div>;
}

function ThreadRow({ thread, activeThreadId, onOpenThread, onRenameThread, onDeleteThread }: {
  thread: Thread;
  activeThreadId?: string | null;
  onOpenThread?: (id: string) => void;
  onRenameThread: (id: string, title: string) => void;
  onDeleteThread: (thread: Thread) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(thread.title);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (editing) inputRef.current?.select(); }, [editing]);

  function commitRename() {
    const trimmed = editTitle.trim();
    if (trimmed && trimmed !== thread.title) onRenameThread(thread.id, trimmed);
    setEditing(false);
  }

  return <div className={`thread-row${activeThreadId === thread.id ? " is-current" : ""}${thread.resolved ? " is-resolved" : ""}`}>
    {editing
      ? <input ref={inputRef} className="chat-rename-input" aria-label="Thread name" value={editTitle} onChange={(event) => setEditTitle(event.target.value)} onBlur={commitRename} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); commitRename(); } if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setEditTitle(thread.title); setEditing(false); } }} />
      : <button className="thread-link" aria-current={activeThreadId === thread.id ? "true" : undefined} title={thread.anchorExact} onClick={() => onOpenThread?.(thread.id)}>
          {thread.resolved ? <Check size={14} /> : <TextQuote size={15} />}<span>{thread.title.replace(/[*`#]/g, "")}</span>
        </button>}
    <ItemMenu label={`Thread options: ${thread.title}`} onRename={() => { setEditTitle(thread.title); setEditing(true); }} onDelete={() => onDeleteThread(thread)} />
  </div>;
}

export function Sidebar({ chats, folders, currentChatId, threads, activeThreadId, onChat, onNewChat, onOpenThread, onDeleteChat, onMoveChat, onRenameChat, onRenameThread, onDeleteThread, onRenameFolder, onDeleteFolder, onMoveFolder, onCreateFolder, onDropChat, mobileOpen, onCloseMobile, theme, onToggleTheme, locked, searchOpen, onSearch, onSwitcher, children }: ChatActions & FolderActions & {
  chats: Chat[];
  folders: Folder[];
  threads: Thread[];
  activeThreadId?: string | null;
  onNewChat: () => void;
  onOpenThread?: (id: string) => void;
  onRenameThread: (id: string, title: string) => void;
  onDeleteThread: (thread: Thread) => void;
  mobileOpen: boolean;
  onCloseMobile: () => void;
  theme: string;
  onToggleTheme: () => void;
  searchOpen: boolean;
  onSearch: () => void;
  onSwitcher: () => void;
  children?: React.ReactNode;
}) {
  const rootFolders = folders.filter((folder) => folder.parentId === null);
  const unsortedChats = chats.filter((chat) => chat.folderId === null);
  const actions = { currentChatId, onChat, onDeleteChat, onMoveChat, onRenameChat, onDropChat, locked, onRenameFolder, onDeleteFolder, onMoveFolder, onCreateFolder };

  return <>
    {mobileOpen && <button className="sidebar-scrim" aria-label="Close navigation" onClick={onCloseMobile} />}
    <aside className={`sidebar${mobileOpen ? " is-open" : ""}`} aria-label="Conversations and threads">
      <div className="sidebar-brand"><Logo size={31} /><span>Threads</span><Button variant="ghost" size="icon" className="mobile-only" aria-label="Close navigation" onClick={onCloseMobile}><X /></Button></div>
      <div className="sidebar-tools"><Button variant="outline" onClick={onNewChat} className="new-chat-button"><Plus size={16} />New chat</Button><Button variant="outline" size="icon" className="sidebar-search-button" aria-label="Search conversation" title="Search messages (⌘F)" onClick={onSearch}><Search size={15} /></Button></div>
      <button className="sidebar-library-button" onClick={onSwitcher} aria-label="Browse library" title="Browse library (⌘K)"><Library size={15} /><span>Browse library</span><kbd>⌘ K</kbd></button>
      {children}
      <div className="sidebar-scroll" hidden={searchOpen}>
        <section className="sidebar-section" aria-label="Chat list" onDragOver={(event) => {
          if (!isChatDrag(event.dataTransfer)) return;
          event.preventDefault(); event.dataTransfer.dropEffect = "move";
        }} onDrop={(event) => {
          if (!isChatDrag(event.dataTransfer)) return;
          event.preventDefault();
          const id = event.dataTransfer.getData(CHAT_DRAG_MIME) || event.dataTransfer.getData("text/plain");
          if (id) onDropChat(id, null);
        }}>
          <h2>Conversations<button className="sidebar-new-folder" aria-label="New folder" title="New folder" onClick={() => onCreateFolder(null)}><FolderPlus size={14} /></button></h2>
          <div className="chat-list">
            {rootFolders.map((folder) => <FolderNode key={folder.id} folder={folder} folders={folders} chats={chats} {...actions} />)}
            {rootFolders.length > 0 && <div className="unsorted-heading">Unsorted<span>{unsortedChats.length}</span></div>}
            {unsortedChats.map((chat) => <ChatRow key={chat.id} chat={chat} {...actions} />)}
          </div>
        </section>
        <section className="sidebar-section thread-section" aria-label="Thread list">
          <h2>Threads<span>{threads.length || ""}</span></h2>
          {currentChatId && <p className="thread-parent-label">of {chats.find((chat) => chat.id === currentChatId)?.title}</p>}
          {threads.length ? <div className="thread-nav-list">{threads.map((thread) => <ThreadRow key={thread.id} thread={thread} activeThreadId={activeThreadId} onOpenThread={onOpenThread} onRenameThread={onRenameThread} onDeleteThread={onDeleteThread} />)}</div> : <div className="empty-threads"><span className="empty-thread-mark"><TextQuote size={22} /></span><p>A thought worth following?</p><span>Select a passage in an answer.<br />Keep the conversation beside it.</span></div>}
        </section>
      </div>
      <footer className="sidebar-footer"><Button variant="ghost" size="icon" aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`} title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`} onClick={onToggleTheme}>{theme === "dark" ? <Sun /> : <Moon />}</Button></footer>
    </aside>
  </>;
}
