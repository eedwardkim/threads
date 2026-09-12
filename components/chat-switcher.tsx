"use client";

import { useState, useMemo, useCallback, useRef, type DragEvent } from "react";
import { ChevronRight, FolderPlus, MessageSquare, Plus, Search } from "lucide-react";
import type { Chat, Folder } from "@/lib/types";
import { CHAT_DRAG_MIME, isChatDrag, setChatDragImage } from "@/lib/drag-ghost";
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
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const dragCleanup = useRef<(() => void) | null>(null);
  const folderMap = useMemo(() => new Map(folders.map((f) => [f.id, f])), [folders]);
  const breadcrumb = useMemo(() => buildBreadcrumb(folderId, folderMap), [folderId, folderMap]);

  const childFolders = folders.filter((f) => f.parentId === folderId);
  const childChats = chats.filter((c) => c.folderId === folderId);
  const searchHits = query ? chats.filter((c) => c.title.toLowerCase().includes(query.toLowerCase())) : null;

  const endDrag = useCallback(() => {
    setDraggingId(null);
    setDropTarget(null);
    dragCleanup.current?.();
    dragCleanup.current = null;
  }, []);

  const onDragStart = useCallback((e: DragEvent, chat: Chat) => {
    e.dataTransfer.setData(CHAT_DRAG_MIME, chat.id);
    e.dataTransfer.setData("text/plain", chat.id);
    e.dataTransfer.effectAllowed = "move";
    dragCleanup.current = setChatDragImage(e.dataTransfer, chat.title);
    setDraggingId(chat.id);
  }, []);

  const onFolderDragOver = useCallback((e: DragEvent, id: string) => {
    if (!isChatDrag(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDropTarget(id);
  }, []);

  const onBreadcrumbDragOver = useCallback((e: DragEvent, id: string) => {
    if (!isChatDrag(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDropTarget(id);
  }, []);

  const onFolderDrop = useCallback((e: DragEvent, targetFolderId: string) => {
    if (!isChatDrag(e.dataTransfer)) return;
    e.preventDefault();
    const chatId = e.dataTransfer.getData(CHAT_DRAG_MIME) || e.dataTransfer.getData("text/plain");
    if (chatId && onMoveChat) onMoveChat(chatId, targetFolderId);
    endDrag();
  }, [onMoveChat, endDrag]);

  const onBreadcrumbDrop = useCallback((e: DragEvent, targetFolderId: string | null) => {
    if (!isChatDrag(e.dataTransfer)) return;
    e.preventDefault();
    const chatId = e.dataTransfer.getData(CHAT_DRAG_MIME) || e.dataTransfer.getData("text/plain");
    if (chatId && onMoveChat) onMoveChat(chatId, targetFolderId);
    endDrag();
  }, [onMoveChat, endDrag]);

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="folder-browser max-w-2xl">
        <div className="fb-topbar">
          <nav className="fb-breadcrumb" aria-label="Folder path">
            <button
              className={`${!folderId ? "is-current" : ""}${dropTarget === "__root__" ? " is-drop-target" : ""}`}
              onClick={() => setFolderId(null)}
              onDragOver={(e) => onBreadcrumbDragOver(e, "__root__")}
              onDragLeave={() => setDropTarget(null)}
              onDrop={(e) => onBreadcrumbDrop(e, null)}
            >All</button>
            {breadcrumb.map((f) => (
              <span key={f.id}>
                <ChevronRight size={11} />
                <button
                  className={`${f.id === folderId ? "is-current" : ""}${dropTarget === f.id ? " is-drop-target" : ""}`}
                  onClick={() => setFolderId(f.id)}
                  onDragOver={(e) => onBreadcrumbDragOver(e, f.id)}
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

        <div className={`fb-grid${draggingId ? " is-dragging" : ""}`} role="list">
          {searchHits ? (
            <>
              {searchHits.map((chat) => (
                <button
                  key={chat.id} role="listitem"
                  className={`fb-chat-card${chat.id === currentChatId ? " is-current" : ""}${chat.id === draggingId ? " is-drag-source" : ""}`}
                  draggable
                  onDragStart={(e) => onDragStart(e, chat)}
                  onDragEnd={endDrag}
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
                  className={`fb-chat-card${chat.id === currentChatId ? " is-current" : ""}${chat.id === draggingId ? " is-drag-source" : ""}`}
                  draggable
                  onDragStart={(e) => onDragStart(e, chat)}
                  onDragEnd={endDrag}
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
