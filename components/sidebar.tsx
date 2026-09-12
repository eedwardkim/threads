"use client";

import { useState, useRef, useEffect, type DragEvent } from "react";
import { Check, ChevronRight, EllipsisVertical, FolderIcon, FolderInput, MessageSquare, Moon, Pencil, Plus, Search, Sun, TextQuote, Trash2, X } from "lucide-react";
import type { Chat, Folder, Thread } from "@/lib/types";
import { CHAT_DRAG_MIME, isChatDrag, setChatDragImage } from "@/lib/drag-ghost";
import { Button } from "./ui/button";
import { Logo } from "./logo";

function FolderNode({ folder, folders, chats, currentChatId, onChat, onDeleteChat, onMoveChat, onRenameChat, onRenameFolder, onDeleteFolder, onMoveFolder, onDropChat, locked }: {
  folder: Folder;
  folders: Folder[];
  chats: Chat[];
  currentChatId: string | null;
  onChat: (id: string) => void;
  onDeleteChat: (chat: Chat) => void;
  onMoveChat: (chatId: string) => void;
  onRenameChat: (id: string, title: string) => void;
  onRenameFolder: (id: string, name: string) => void;
  onDeleteFolder: (id: string) => void;
  onMoveFolder: (id: string) => void;
  onDropChat: (chatId: string, folderId: string | null) => void;
  locked: boolean;
}) {
  const [expanded, setExpanded] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(folder.name);
  const [dropHover, setDropHover] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const expandTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const children = folders.filter((f) => f.parentId === folder.id);
  const folderChats = chats.filter((c) => c.folderId === folder.id);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setMenuOpen(false); return; }
      if (e.key.toLowerCase() === "r") { e.preventDefault(); setMenuOpen(false); setEditName(folder.name); setEditing(true); }
      if (e.key.toLowerCase() === "d") { e.preventDefault(); setMenuOpen(false); onDeleteFolder(folder.id); }
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", key); };
  }, [menuOpen, folder, onDeleteFolder]);

  useEffect(() => () => { if (expandTimer.current) clearTimeout(expandTimer.current); }, []);

  function commitRename() {
    const trimmed = editName.trim();
    if (trimmed && trimmed !== folder.name) onRenameFolder(folder.id, trimmed);
    else setEditName(folder.name);
    setEditing(false);
  }

  function clearExpandTimer() {
    if (expandTimer.current) { clearTimeout(expandTimer.current); expandTimer.current = null; }
  }

  const onDragOverFolder = (e: DragEvent) => {
    if (!isChatDrag(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "move";
    setDropHover(true);
    if (!expanded && !expandTimer.current) {
      expandTimer.current = setTimeout(() => { expandTimer.current = null; setExpanded(true); }, 550);
    }
  };
  const onDragLeaveFolder = (e: DragEvent) => {
    e.stopPropagation();
    if (e.relatedTarget instanceof Node && (e.currentTarget as Node).contains(e.relatedTarget)) return;
    setDropHover(false);
    clearExpandTimer();
  };
  const onDropFolder = (e: DragEvent) => {
    if (!isChatDrag(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    setDropHover(false);
    clearExpandTimer();
    const chatId = e.dataTransfer.getData(CHAT_DRAG_MIME) || e.dataTransfer.getData("text/plain");
    if (chatId) onDropChat(chatId, folder.id);
  };

  return <div className="folder-node">
    <div className={`folder-row${dropHover ? " is-drop-target" : ""}`} onDragOver={onDragOverFolder} onDragLeave={onDragLeaveFolder} onDrop={onDropFolder}>
      <button className="folder-toggle" onClick={() => setExpanded(!expanded)} aria-label={expanded ? "Collapse folder" : "Expand folder"}>
        <ChevronRight size={12} className={`folder-chevron${expanded ? " is-expanded" : ""}`} />
      </button>
      {editing
        ? <input ref={inputRef} className="folder-rename-input" value={editName} onChange={(e) => setEditName(e.target.value)} onBlur={commitRename} onKeyDown={(e) => { if (e.key === "Enter") commitRename(); if (e.key === "Escape") { setEditName(folder.name); setEditing(false); } }} />
        : <button className="folder-label" onClick={() => setExpanded(!expanded)}><FolderIcon size={14} /><span>{folder.name}</span></button>
      }
      <div className="chat-menu-wrap" ref={menuRef}>
        <button className="chat-menu-trigger" aria-label="Folder options" onClick={() => setMenuOpen(!menuOpen)}><EllipsisVertical size={13} /></button>
        {menuOpen && <div className="chat-context-menu">
          <button onClick={() => { setMenuOpen(false); setEditName(folder.name); setEditing(true); }}><Pencil size={13} /><span>Rename</span><kbd>R</kbd></button>
          <button onClick={() => { setMenuOpen(false); onMoveFolder(folder.id); }}><FolderInput size={13} /><span>Add to folder</span></button>
          <hr />
          <button className="destructive" onClick={() => { setMenuOpen(false); onDeleteFolder(folder.id); }}><Trash2 size={13} /><span>Delete</span><kbd>D</kbd></button>
        </div>}
      </div>
    </div>
    {expanded && <div className="folder-children" onDragOver={onDragOverFolder} onDragLeave={onDragLeaveFolder} onDrop={onDropFolder}>
      {children.map((child) => <FolderNode key={child.id} folder={child} folders={folders} chats={chats} currentChatId={currentChatId} onChat={onChat} onDeleteChat={onDeleteChat} onMoveChat={onMoveChat} onRenameChat={onRenameChat} onRenameFolder={onRenameFolder} onDeleteFolder={onDeleteFolder} onMoveFolder={onMoveFolder} onDropChat={onDropChat} locked={locked} />)}
      {folderChats.map((chat) => <ChatRow key={chat.id} chat={chat} currentChatId={currentChatId} onChat={onChat} onDeleteChat={onDeleteChat} onMoveChat={onMoveChat} onRenameChat={onRenameChat} onDropChat={onDropChat} locked={locked} />)}
      {!children.length && !folderChats.length && <div className="folder-empty">Empty</div>}
    </div>}
  </div>;
}

function ChatRow({ chat, currentChatId, onChat, onDeleteChat, onMoveChat, onRenameChat, onDropChat, locked }: {
  chat: Chat;
  currentChatId: string | null;
  onChat: (id: string) => void;
  onDeleteChat: (chat: Chat) => void;
  onMoveChat: (chatId: string) => void;
  onRenameChat: (id: string, title: string) => void;
  onDropChat: (chatId: string, folderId: string | null) => void;
  locked: boolean;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(chat.title);
  const [dropHover, setDropHover] = useState(false);
  const [dragging, setDragging] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dragCleanup = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setMenuOpen(false); return; }
      if (e.key.toLowerCase() === "r") { e.preventDefault(); setMenuOpen(false); setEditTitle(chat.title); setEditing(true); }
      if (e.key.toLowerCase() === "d" && !locked) { e.preventDefault(); setMenuOpen(false); onDeleteChat(chat); }
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", key); };
  }, [menuOpen, chat, locked, onDeleteChat]);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  function commitRename() {
    const trimmed = editTitle.trim();
    if (trimmed && trimmed !== chat.title) onRenameChat(chat.id, trimmed);
    setEditing(false);
  }

  const onDragStartRow = (e: DragEvent) => {
    e.dataTransfer.setData(CHAT_DRAG_MIME, chat.id);
    e.dataTransfer.setData("text/plain", chat.id);
    e.dataTransfer.effectAllowed = "move";
    dragCleanup.current = setChatDragImage(e.dataTransfer, chat.title);
    setDragging(true);
  };
  const onDragEndRow = () => {
    setDragging(false);
    dragCleanup.current?.();
    dragCleanup.current = null;
  };
  const onDragOverRow = (e: DragEvent) => {
    if (!isChatDrag(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "move";
    setDropHover(true);
  };
  const onDragLeaveRow = (e: DragEvent) => {
    e.stopPropagation();
    if (e.relatedTarget instanceof Node && (e.currentTarget as Node).contains(e.relatedTarget)) return;
    setDropHover(false);
  };
  const onDropRow = (e: DragEvent) => {
    if (!isChatDrag(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    setDropHover(false);
    const chatId = e.dataTransfer.getData(CHAT_DRAG_MIME) || e.dataTransfer.getData("text/plain");
    if (chatId && chatId !== chat.id) onDropChat(chatId, chat.folderId);
  };

  return <div
    className={`chat-list-row${currentChatId === chat.id ? " is-current" : ""}${dropHover ? " is-drop-target" : ""}${dragging ? " is-drag-source" : ""}`}
    draggable={!editing}
    onDragStart={onDragStartRow}
    onDragEnd={onDragEndRow}
    onDragOver={onDragOverRow}
    onDragLeave={onDragLeaveRow}
    onDrop={onDropRow}
  >
    {editing
      ? <input ref={inputRef} className="chat-rename-input" value={editTitle} onChange={(e) => setEditTitle(e.target.value)} onBlur={commitRename} onKeyDown={(e) => { if (e.key === "Enter") commitRename(); if (e.key === "Escape") { setEditTitle(chat.title); setEditing(false); } }} />
      : <button className="chat-link" aria-current={currentChatId === chat.id ? "page" : undefined} onClick={() => onChat(chat.id)}><MessageSquare size={15} /><span>{chat.title}</span></button>
    }
    <div className="chat-menu-wrap" ref={menuRef}>
      <button className="chat-menu-trigger" aria-label="Chat options" onClick={() => setMenuOpen(!menuOpen)}><EllipsisVertical size={13} /></button>
      {menuOpen && <div className="chat-context-menu">
        <button onClick={() => { setMenuOpen(false); setEditTitle(chat.title); setEditing(true); }}><Pencil size={13} /><span>Rename</span><kbd>R</kbd></button>
        <button onClick={() => { setMenuOpen(false); onMoveChat(chat.id); }}><FolderInput size={13} /><span>Add to folder</span></button>
        <hr />
        <button className="destructive" disabled={locked} onClick={() => { setMenuOpen(false); onDeleteChat(chat); }}><Trash2 size={13} /><span>Delete</span><kbd>D</kbd></button>
      </div>}
    </div>
  </div>;
}

function ThreadRow({ thread, activeThreadId, onOpenThread, onRenameThread, onDeleteThread }: {
  thread: Thread;
  activeThreadId?: string | null;
  onOpenThread?: (id: string) => void;
  onRenameThread: (id: string, title: string) => void;
  onDeleteThread: (thread: Thread) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(thread.title);
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: MouseEvent) => { if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false); };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setMenuOpen(false); return; }
      if (e.key.toLowerCase() === "r") { e.preventDefault(); setMenuOpen(false); setEditTitle(thread.title); setEditing(true); }
      if (e.key.toLowerCase() === "d") { e.preventDefault(); setMenuOpen(false); onDeleteThread(thread); }
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", key); };
  }, [menuOpen, thread, onDeleteThread]);

  useEffect(() => { if (editing) inputRef.current?.select(); }, [editing]);

  function commitRename() {
    const trimmed = editTitle.trim();
    if (trimmed && trimmed !== thread.title) onRenameThread(thread.id, trimmed);
    setEditing(false);
  }

  return <div className={`thread-row${activeThreadId === thread.id ? " is-current" : ""}${thread.resolved ? " is-resolved" : ""}`}>
    {editing
      ? <input ref={inputRef} className="chat-rename-input" value={editTitle} onChange={(e) => setEditTitle(e.target.value)} onBlur={commitRename} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commitRename(); } if (e.key === "Escape") { setEditTitle(thread.title); setEditing(false); } }} />
      : <button className="thread-link" aria-current={activeThreadId === thread.id ? "true" : undefined} title={thread.anchorExact} onClick={() => onOpenThread?.(thread.id)}>
          {thread.resolved ? <Check size={14} /> : <TextQuote size={15} />}<span>{thread.title.replace(/[*`#]/g, "")}</span>
        </button>}
    <div className="chat-menu-wrap" ref={menuRef}>
      <button className="chat-menu-trigger" aria-label="Thread options" onClick={() => setMenuOpen(!menuOpen)}><EllipsisVertical size={13} /></button>
      {menuOpen && <div className="chat-context-menu">
        <button onClick={() => { setMenuOpen(false); setEditTitle(thread.title); setEditing(true); }}><Pencil size={13} /><span>Rename</span><kbd>R</kbd></button>
        <hr />
        <button className="destructive" onClick={() => { setMenuOpen(false); onDeleteThread(thread); }}><Trash2 size={13} /><span>Delete</span><kbd>D</kbd></button>
      </div>}
    </div>
  </div>;
}

export function Sidebar({ chats, folders, currentChatId, threads, activeThreadId, onChat, onNewChat, onOpenThread, onDeleteChat, onMoveChat, onRenameChat, onRenameThread, onDeleteThread, onRenameFolder, onDeleteFolder, onMoveFolder, onDropChat, mobileOpen, onCloseMobile, theme, onToggleTheme, locked, searchOpen, onSearch, onSwitcher, children }: {
  chats: Chat[];
  folders: Folder[];
  currentChatId: string | null;
  threads: Thread[];
  activeThreadId?: string | null;
  onChat: (id: string) => void;
  onNewChat: () => void;
  onOpenThread?: (id: string) => void;
  onDeleteChat: (chat: Chat) => void;
  onMoveChat: (chatId: string) => void;
  onRenameChat: (id: string, title: string) => void;
  onRenameThread: (id: string, title: string) => void;
  onDeleteThread: (thread: Thread) => void;
  onRenameFolder: (id: string, name: string) => void;
  onDeleteFolder: (id: string) => void;
  onMoveFolder: (id: string) => void;
  onDropChat: (chatId: string, folderId: string | null) => void;
  mobileOpen: boolean;
  onCloseMobile: () => void;
  theme: string;
  onToggleTheme: () => void;
  locked: boolean;
  searchOpen: boolean;
  onSearch: () => void;
  onSwitcher: () => void;
  children?: React.ReactNode;
}) {
  const rootFolders = folders.filter((f) => f.parentId === null);
  const unsortedChats = chats.filter((c) => c.folderId === null);

  const onRootDragOver = (e: DragEvent) => {
    if (!isChatDrag(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  };
  const onRootDrop = (e: DragEvent) => {
    if (!isChatDrag(e.dataTransfer)) return;
    e.preventDefault();
    const chatId = e.dataTransfer.getData(CHAT_DRAG_MIME) || e.dataTransfer.getData("text/plain");
    if (chatId) onDropChat(chatId, null);
  };

  return <>
    {mobileOpen && <button className="sidebar-scrim" aria-label="Close navigation" onClick={onCloseMobile} />}
    <aside className={`sidebar${mobileOpen ? " is-open" : ""}`} aria-label="Conversations and threads">
      <div className="sidebar-brand"><Logo size={31} /><span>Threads</span><Button variant="ghost" size="icon" className="mobile-only" aria-label="Close navigation" onClick={onCloseMobile}><X /></Button></div>
      <div className="sidebar-tools"><Button variant="outline" onClick={onNewChat} className="new-chat-button"><Plus size={16} />New chat</Button><Button variant="outline" size="icon" className="sidebar-search-button" aria-label="Search conversation" title="Search messages (⌘F)" onClick={onSearch}><Search size={15} /></Button></div>
      {children}
      <div className="sidebar-scroll" hidden={searchOpen}>
        <section className="sidebar-section" aria-label="Chat list" onDragOver={onRootDragOver} onDrop={onRootDrop}>
          <h2>Conversations<span className="conversations-actions"><button className="switcher-shortcut" aria-label="Switch conversation" title="Switch conversation (⌘K)" onClick={onSwitcher}>⌘ K</button></span></h2>
          <div className="chat-list">
            {rootFolders.map((folder) => <FolderNode key={folder.id} folder={folder} folders={folders} chats={chats} currentChatId={currentChatId} onChat={onChat} onDeleteChat={onDeleteChat} onMoveChat={onMoveChat} onRenameChat={onRenameChat} onRenameFolder={onRenameFolder} onDeleteFolder={onDeleteFolder} onMoveFolder={onMoveFolder} onDropChat={onDropChat} locked={locked} />)}
            {unsortedChats.map((chat) => <ChatRow key={chat.id} chat={chat} currentChatId={currentChatId} onChat={onChat} onDeleteChat={onDeleteChat} onMoveChat={onMoveChat} onRenameChat={onRenameChat} onDropChat={onDropChat} locked={locked} />)}
          </div>
        </section>
        <section className="sidebar-section thread-section" aria-label="Thread list">
          <h2>Threads<span>{threads.length || ""}</span></h2>
          {currentChatId && <p className="thread-parent-label">of {chats.find((c) => c.id === currentChatId)?.title}</p>}
          {threads.length ? <div className="thread-nav-list">{threads.map((thread) => <ThreadRow key={thread.id} thread={thread} activeThreadId={activeThreadId} onOpenThread={onOpenThread} onRenameThread={onRenameThread} onDeleteThread={onDeleteThread} />)}</div> : <div className="empty-threads"><span className="empty-thread-mark"><TextQuote size={22} /></span><p>A thought worth following?</p><span>Select a passage in an answer.<br />Keep the conversation beside it.</span></div>}
        </section>
      </div>
      <footer className="sidebar-footer"><Button variant="ghost" size="icon" aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`} title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`} onClick={onToggleTheme}>{theme === "dark" ? <Sun /> : <Moon />}</Button></footer>
    </aside>
  </>;
}
