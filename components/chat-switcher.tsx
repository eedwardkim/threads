"use client";

import { useState } from "react";
import { Check, MessageSquare, Plus, Search } from "lucide-react";
import type { Chat } from "@/lib/types";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";

export function ChatSwitcher({ chats, currentChatId, onClose, onSelect, onNewChat }: { chats: Chat[]; currentChatId: string | null; onClose: () => void; onSelect: (id: string) => void; onNewChat: () => void }) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const filtered = chats.filter((chat) => chat.title.toLowerCase().includes(query.toLowerCase()));
  const active = Math.min(index, Math.max(0, filtered.length - 1));
  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}><DialogContent className="chat-switcher"><DialogHeader><DialogTitle>Switch conversation</DialogTitle><DialogDescription>Pick up a thought where you left it.</DialogDescription></DialogHeader>
    <div className="switcher-input"><Search size={16} /><input autoFocus role="combobox" aria-expanded="true" aria-controls="conversation-options" aria-activedescendant={filtered[active] ? `switch-${filtered[active].id}` : undefined} aria-label="Find a conversation" placeholder="Find a conversation…" value={query} onChange={(event) => { setQuery(event.target.value); setIndex(0); }} onKeyDown={(event) => {
      if (event.key === "ArrowDown") { event.preventDefault(); setIndex(Math.min(active + 1, filtered.length - 1)); }
      if (event.key === "ArrowUp") { event.preventDefault(); setIndex(Math.max(0, active - 1)); }
      if (event.key === "Enter" && filtered[active]) { event.preventDefault(); onSelect(filtered[active].id); onClose(); }
    }} /></div>
    <div id="conversation-options" role="listbox" aria-label="Conversations" className="switcher-results">{filtered.map((chat, position) => <button id={`switch-${chat.id}`} role="option" aria-selected={active === position} key={chat.id} className={active === position ? "is-active" : ""} onMouseEnter={() => setIndex(position)} onClick={() => { onSelect(chat.id); onClose(); }}><MessageSquare size={15} /><span>{chat.title}</span>{chat.id === currentChatId && <Check size={14} />}</button>)}{!filtered.length && <p>No conversations match.</p>}</div>
    <Button variant="ghost" onClick={() => { onNewChat(); onClose(); }} className="switcher-new"><Plus size={15} />Start a new conversation</Button>
  </DialogContent></Dialog>;
}
