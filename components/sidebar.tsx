"use client";

import { Check, Database, MessageSquare, Moon, Plus, Search, Sun, TextQuote, Trash2, X } from "lucide-react";
import type { Chat, Thread } from "@/lib/types";
import { Button } from "./ui/button";
import { Logo } from "./logo";

export function Sidebar({ chats, currentChatId, threads, activeThreadId, onChat, onNewChat, onOpenThread, onDeleteChat, mobileOpen, onCloseMobile, theme, onToggleTheme, locked, searchOpen, onSearch, onSwitcher, children }: {
  chats: Chat[];
  currentChatId: string | null;
  threads: Thread[];
  activeThreadId?: string | null;
  onChat: (id: string) => void;
  onNewChat: () => void;
  onOpenThread?: (id: string) => void;
  onDeleteChat: (chat: Chat) => void;
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
  return <>
    {mobileOpen && <button className="sidebar-scrim" aria-label="Close navigation" onClick={onCloseMobile} />}
    <aside className={`sidebar${mobileOpen ? " is-open" : ""}`} aria-label="Conversations and threads">
      <div className="sidebar-brand"><Logo size={31} /><span>ThreadLLM</span><Button variant="ghost" size="icon" className="mobile-only" aria-label="Close navigation" onClick={onCloseMobile}><X /></Button></div>
      <div className="sidebar-tools"><Button variant="outline" onClick={onNewChat} className="new-chat-button"><Plus size={16} />New chat</Button><Button variant="outline" size="icon" className="sidebar-search-button" aria-label="Search conversation" title="Search messages (⌘F)" onClick={onSearch}><Search size={15} /></Button></div>
      {children}
      <div className="sidebar-scroll" hidden={searchOpen}>
        <section className="sidebar-section" aria-label="Chat list">
          <h2>Conversations<button className="switcher-shortcut" aria-label="Switch conversation" title="Switch conversation (⌘K)" onClick={onSwitcher}>⌘ K</button></h2>
          <div className="chat-list">{chats.map((chat) => <div key={chat.id} className={`chat-list-row${currentChatId === chat.id ? " is-current" : ""}`}>
            <button className="chat-link" aria-current={currentChatId === chat.id ? "page" : undefined} onClick={() => onChat(chat.id)}><MessageSquare size={15} /><span>{chat.title}</span></button>
            <Button variant="ghost" size="icon" className="delete-chat-button" aria-label={`Delete chat: ${chat.title}`} title="Delete chat" disabled={locked} onClick={() => onDeleteChat(chat)}><Trash2 size={13} /></Button>
          </div>)}</div>
        </section>
        <section className="sidebar-section thread-section" aria-label="Thread list">
          <h2>Threads<span>{threads.length || ""}</span></h2>
          {threads.length ? <div className="thread-nav-list">{threads.map((thread) => <button key={thread.id} className={`thread-link${thread.resolved ? " is-resolved" : ""}${activeThreadId === thread.id ? " is-current" : ""}`} onClick={() => onOpenThread?.(thread.id)} aria-current={activeThreadId === thread.id ? "true" : undefined} title={thread.anchorExact}>
            {thread.resolved ? <Check size={14} /> : <TextQuote size={15} />}<span>{thread.title.replace(/[*`#]/g, "")}</span>
          </button>)}</div> : <div className="empty-threads"><span className="empty-thread-mark"><TextQuote size={22} /></span><p>A thought worth following?</p><span>Select a passage in an answer.<br />Keep the conversation beside it.</span></div>}
        </section>
      </div>
      <footer className="sidebar-footer"><div><Database size={14} /><span>Saved on this device</span></div><Button variant="ghost" size="icon" aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`} title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`} onClick={onToggleTheme}>{theme === "dark" ? <Sun /> : <Moon />}</Button></footer>
    </aside>
  </>;
}
