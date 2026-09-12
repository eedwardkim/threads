"use client";

import { useState, useMemo, useCallback, type DragEvent } from "react";
import { ChevronRight, FolderPlus, MessageSquare, Plus, Search } from "lucide-react";
import type { Chat, Folder } from "@/lib/types";
import { Button } from "./ui/button";
import { Dialog, DialogContent } from "./ui/dialog";

const FOLDER_PALETTE = [
  "#fbbf24", "#f472b6", "#fb923c", "#a78bfa",
  "#34d399", "#60a5fa", "#f87171", "#2dd4bf",
];

function colorFor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = ((h << 5) - h + id.charCodeAt(i)) | 0;
  return FOLDER_PALETTE[Math.abs(h) % FOLDER_PALETTE.length];
}

function buildBreadcrumb(folderId: string | null, folderMap: Map<string, Folder>): Folder[] {
  const crumbs: Folder[] = [];
  let cur = folderId ? folderMap.get(folderId) : undefined;
  while (cur) {
    crumbs.unshift(cur);
    cur = cur.parentId ? folderMap.get(cur.parentId) : undefined;
  }
  return crumbs;
}

export function ChatSwitcher({
  chats, folders, currentChatId, onClose, onSelect, onNewChat, onCreateFolder, onMoveChat,
}: {
  chats: Chat[];
  folders: Folder[];
  currentChatId: string | null;
  onClose: () => void;
  onSelect: (id: string) => void;
  onNewChat: () => void;
  onCreateFolder?: () => void;
  onMoveChat?: (chatId: string, folderId: string | null) => void;
}) {
  const [query, setQuery] = useState("");
  const [folderId, setFolderId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const folderMap = useMemo(() => new Map(folders.map((f) => [f.id, f])), [folders]);
  const breadcrumb = useMemo(() => buildBreadcrumb(folderId, folderMap), [folderId, folderMap]);

  const childFolders = folders.filter((f) => f.parentId === folderId);
  const childChats = chats.filter((c) => c.folderId === folderId);
  const searchHits = query ? chats.filter((c) => c.title.toLowerCase().includes(query.toLowerCase())) : null;

  const onDragStart = useCallback((e: DragEvent, chatId: string) => {
    e.dataTransfer.setData("text/plain", chatId);
    e.dataTransfer.effectAllowed = "move";
    setDragging(true);
  }, []);

  const onDragEnd = useCallback(() => {
    setDragging(false);
    setDropTarget(null);
  }, []);

  const onFolderDragOver = useCallback((e: DragEvent, id: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDropTarget(id);
  }, []);

  const onFolderDrop = useCallback((e: DragEvent, targetFolderId: string) => {
    e.preventDefault();
    const chatId = e.dataTransfer.getData("text/plain");
    if (chatId && onMoveChat) onMoveChat(chatId, targetFolderId);
    setDropTarget(null);
    setDragging(false);
  }, [onMoveChat]);

  const onBreadcrumbDrop = useCallback((e: DragEvent, targetFolderId: string | null) => {
    e.preventDefault();
    const chatId = e.dataTransfer.getData("text/plain");
    if (chatId && onMoveChat) onMoveChat(chatId, targetFolderId);
    setDropTarget(null);
    setDragging(false);
  }, [onMoveChat]);

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="folder-browser max-w-2xl">
        <div className="fb-topbar">
          <nav className="fb-breadcrumb" aria-label="Folder path">
            <button
              className={`${!folderId ? "is-current" : ""}${dropTarget === "__root__" ? " is-drop-target" : ""}`}
              onClick={() => setFolderId(null)}
              onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; setDropTarget("__root__"); }}
              onDragLeave={() => setDropTarget(null)}
              onDrop={(e) => onBreadcrumbDrop(e, null)}
            >All</button>
            {breadcrumb.map((f) => (
              <span key={f.id}>
                <ChevronRight size={11} />
                <button
                  className={`${f.id === folderId ? "is-current" : ""}${dropTarget === f.id ? " is-drop-target" : ""}`}
                  onClick={() => setFolderId(f.id)}
                  onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; setDropTarget(f.id); }}
                  onDragLeave={() => setDropTarget(null)}
                  onDrop={(e) => onBreadcrumbDrop(e, f.id)}
                >{f.name}</button>
              </span>
            ))}
          </nav>
          <div className="fb-actions">
            {onCreateFolder && <Button variant="ghost" size="icon" className="fb-action-btn" aria-label="New folder" title="New folder" onClick={onCreateFolder}><FolderPlus size={15} /></Button>}
            <Button variant="outline" className="fb-new-chat" onClick={() => { onNewChat(); onClose(); }}><Plus size={14} />New</Button>
          </div>
        </div>

        <div className="fb-search">
          <Search size={14} />
          <input autoFocus placeholder="Search conversations…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search conversations" />
        </div>

        <div className={`fb-grid${dragging ? " is-dragging" : ""}`} role="list">
          {searchHits ? (
            <>
              {searchHits.map((chat) => (
                <button
                  key={chat.id} role="listitem"
                  className={`fb-chat-card${chat.id === currentChatId ? " is-current" : ""}`}
                  draggable
                  onDragStart={(e) => onDragStart(e, chat.id)}
                  onDragEnd={onDragEnd}
                  onClick={() => { onSelect(chat.id); onClose(); }}
                >
                  <div className="fb-doc-icon"><MessageSquare size={18} /></div>
                  <span className="fb-card-label">{chat.title}</span>
                </button>
              ))}
              {!searchHits.length && <p className="fb-empty">No conversations match.</p>}
            </>
          ) : (
            <>
              {childFolders.map((folder) => {
                const count = chats.filter((c) => c.folderId === folder.id).length;
                return (
                  <button
                    key={folder.id} role="listitem"
                    className={`fb-folder-card${dropTarget === folder.id ? " is-drop-target" : ""}`}
                    onClick={() => { setFolderId(folder.id); setQuery(""); }}
                    onDragOver={(e) => onFolderDragOver(e, folder.id)}
                    onDragLeave={() => setDropTarget(null)}
                    onDrop={(e) => onFolderDrop(e, folder.id)}
                  >
                    <div className="fb-folder-icon" style={{ "--folder-color": colorFor(folder.id) } as React.CSSProperties} />
                    <span className="fb-card-label">{folder.name}</span>
                    {count > 0 && <span className="fb-card-count">{count}</span>}
                  </button>
                );
              })}
              {childChats.map((chat) => (
                <button
                  key={chat.id} role="listitem"
                  className={`fb-chat-card${chat.id === currentChatId ? " is-current" : ""}`}
                  draggable
                  onDragStart={(e) => onDragStart(e, chat.id)}
                  onDragEnd={onDragEnd}
                  onClick={() => { onSelect(chat.id); onClose(); }}
                >
                  <div className="fb-doc-icon"><MessageSquare size={18} /></div>
                  <span className="fb-card-label">{chat.title}</span>
                </button>
              ))}
              {!childFolders.length && !childChats.length && (
                <p className="fb-empty">{folderId ? "This folder is empty." : "No conversations yet."}</p>
              )}
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
