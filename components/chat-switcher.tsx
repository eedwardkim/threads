"use client";

import { useState, useMemo, useCallback, useEffect, useRef, type DragEvent } from "react";
import { ArrowLeft, ChevronRight, Folder, FolderPlus, LayoutGrid, Library, List, MessageSquare, Pencil, Plus, RotateCcw, Search, X } from "lucide-react";
import type { Chat, Folder as ChatFolder } from "@/lib/types";
import { CHAT_DRAG_MIME, isChatDrag, setChatDragImage } from "@/lib/drag-ghost";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./ui/dialog";

function buildBreadcrumb(folderId: string | null, folderMap: Map<string, ChatFolder>): ChatFolder[] {
  const crumbs: ChatFolder[] = [];
  const seen = new Set<string>();
  let current = folderId ? folderMap.get(folderId) : undefined;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    crumbs.unshift(current);
    current = current.parentId ? folderMap.get(current.parentId) : undefined;
  }
  return crumbs;
}

function quantity(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export function ChatSwitcher({
  chats, folders, currentChatId, onClose, onSelect, onNewChat, onCreateFolder, onMoveChat, onRenameChat, onRenameFolder,
  onRestoreDemo, restoringDemo = false, restoreDisabled = false,
}: {
  chats: Chat[];
  folders: ChatFolder[];
  currentChatId: string | null;
  onClose: () => void;
  onSelect: (id: string) => void;
  onNewChat: (folderId: string | null) => void;
  onCreateFolder: (parentId: string | null) => void;
  onMoveChat: (chatId: string, folderId: string | null) => void;
  onRenameChat: (chat: Chat) => void;
  onRenameFolder: (folder: ChatFolder) => void;
  onRestoreDemo?: () => void;
  restoringDemo?: boolean;
  restoreDisabled?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [view, setView] = useState<"grid" | "list">("grid");
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const dragCleanup = useRef<(() => void) | null>(null);
  const folderMap = useMemo(() => new Map(folders.map((folder) => [folder.id, folder])), [folders]);
  const folderId = selectedFolderId && folderMap.has(selectedFolderId) ? selectedFolderId : null;
  const breadcrumb = buildBreadcrumb(folderId, folderMap);
  const search = query.trim().toLowerCase();
  const visibleFolders = folders.filter((folder) => search ? folder.name.toLowerCase().includes(search) : folder.parentId === folderId);
  const visibleChats = chats.filter((chat) => search ? chat.title.toLowerCase().includes(search) : chat.folderId === folderId);
  const itemCount = visibleFolders.length + visibleChats.length;
  const pathFor = (id: string | null) => buildBreadcrumb(id, folderMap).map((folder) => folder.name).join(" / ") || "Library";

  useEffect(() => () => dragCleanup.current?.(), []);

  function navigate(id: string | null) {
    setSelectedFolderId(id);
    setQuery("");
    setDropTarget(null);
  }

  const endDrag = useCallback(() => {
    setDraggingId(null);
    setDropTarget(null);
    dragCleanup.current?.();
    dragCleanup.current = null;
  }, []);

  function startDrag(event: DragEvent, chat: Chat) {
    if ((event.target as HTMLElement).closest(".fb-rename")) { event.preventDefault(); return; }
    event.dataTransfer.setData(CHAT_DRAG_MIME, chat.id);
    event.dataTransfer.setData("text/plain", chat.id);
    event.dataTransfer.effectAllowed = "move";
    dragCleanup.current?.();
    dragCleanup.current = setChatDragImage(event.dataTransfer, chat.title);
    setDraggingId(chat.id);
  }

  function dragOver(event: DragEvent, id: string | null) {
    if (!isChatDrag(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    setDropTarget(id ?? "__root__");
  }

  function dragLeave(event: DragEvent) {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
    event.stopPropagation();
    setDropTarget(null);
  }

  function drop(event: DragEvent, id: string | null) {
    if (!isChatDrag(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    const chatId = event.dataTransfer.getData(CHAT_DRAG_MIME) || event.dataTransfer.getData("text/plain");
    if (chatId) onMoveChat(chatId, id);
    endDrag();
  }

  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent className="folder-browser">
      <div className="fb-topbar">
        <span className="fb-library-icon" aria-hidden="true"><Library size={20} /></span>
        <div className="fb-heading">
          <DialogTitle>Library</DialogTitle>
          <DialogDescription>A place for every conversation.</DialogDescription>
        </div>
        <div className="fb-actions">
          <Button variant="outline" size="sm" aria-label="New folder" onClick={() => onCreateFolder(folderId)}><FolderPlus size={15} /><span>New folder</span></Button>
          <Button size="sm" aria-label="New conversation" onClick={() => { onNewChat(folderId); onClose(); }}><Plus size={15} /><span>New chat</span></Button>
        </div>
      </div>

      <div className="fb-toolbar">
        <div className="fb-search">
          <Search size={15} />
          <input autoFocus placeholder="Search conversations and folders…" value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Search library" />
          {query && <button aria-label="Clear search" onClick={() => setQuery("")}><X size={14} /></button>}
        </div>
        <div className="fb-view-toggle" role="group" aria-label="Library view">
          <button aria-label="Grid view" title="Grid view" aria-pressed={view === "grid"} onClick={() => setView("grid")}><LayoutGrid size={15} /></button>
          <button aria-label="List view" title="List view" aria-pressed={view === "list"} onClick={() => setView("list")}><List size={16} /></button>
        </div>
      </div>

      <div className="fb-location">
        <button className="fb-back" aria-label="Back to parent folder" disabled={!folderId} onClick={() => navigate(folderMap.get(folderId!)?.parentId ?? null)}><ArrowLeft size={15} /></button>
        <nav className="fb-breadcrumb" aria-label="Folder path">
          <button className={`${!folderId ? "is-current" : ""}${dropTarget === "__root__" ? " is-drop-target" : ""}`}
            aria-current={!folderId ? "location" : undefined} onClick={() => navigate(null)}
            onDragOver={(event) => dragOver(event, null)} onDragLeave={dragLeave} onDrop={(event) => drop(event, null)}>Library</button>
          {breadcrumb.map((folder) => <span key={folder.id}>
            <ChevronRight size={12} />
            <button title={folder.name} className={`${folder.id === folderId ? "is-current" : ""}${dropTarget === folder.id ? " is-drop-target" : ""}`}
              aria-current={folder.id === folderId ? "location" : undefined} onClick={() => navigate(folder.id)}
              onDragOver={(event) => dragOver(event, folder.id)} onDragLeave={dragLeave} onDrop={(event) => drop(event, folder.id)}>{folder.name}</button>
          </span>)}
        </nav>
        <span className="fb-result-count" aria-live="polite">{quantity(itemCount, search ? "result" : "item")}</span>
      </div>

      <div className={`fb-content is-${view}${draggingId ? " is-dragging" : ""}`}>
        {visibleFolders.length > 0 && <section className="fb-section" aria-label="Folders">
          <h3>Folders<span>{visibleFolders.length}</span></h3>
          <div className="fb-grid fb-folder-grid" role="list">
            {visibleFolders.map((folder) => {
              const chatCount = chats.filter((chat) => chat.folderId === folder.id).length;
              const folderCount = folders.filter((child) => child.parentId === folder.id).length;
              const details = [folderCount ? quantity(folderCount, "folder") : "", chatCount ? quantity(chatCount, "chat") : ""].filter(Boolean).join(" · ") || "Empty folder";
              return <div key={folder.id} role="listitem" className={`fb-folder-card${dropTarget === folder.id ? " is-drop-target" : ""}`}
                onDragOver={(event) => dragOver(event, folder.id)} onDragLeave={dragLeave} onDrop={(event) => drop(event, folder.id)}>
                <button className="fb-open-item" aria-label={`Open folder: ${folder.name}`} onClick={() => navigate(folder.id)}
                  onKeyDown={(event) => { if (event.key === "F2") { event.preventDefault(); onRenameFolder(folder); } }}>
                  <span className="fb-folder-icon" aria-hidden="true"><Folder size={22} /></span>
                  <span className="fb-card-text"><span className="fb-card-label" title={folder.name}>{folder.name}</span><span className="fb-card-meta" title={search ? pathFor(folder.parentId) : details}>{search ? pathFor(folder.parentId) : details}</span></span>
                </button>
                <button className="fb-rename" aria-label={`Rename folder: ${folder.name}`} title="Rename folder (F2)" onClick={() => onRenameFolder(folder)}><Pencil size={13} /></button>
              </div>;
            })}
          </div>
        </section>}

        {visibleChats.length > 0 && <section className="fb-section" aria-label="Conversations">
          <h3>{!search && !folderId && folders.length ? "Unsorted conversations" : "Conversations"}<span>{visibleChats.length}</span></h3>
          <div className="fb-grid fb-chat-grid" role="list">
            {visibleChats.map((chat) => <div key={chat.id} role="listitem"
              className={`fb-chat-card${chat.id === currentChatId ? " is-current" : ""}${chat.id === draggingId ? " is-drag-source" : ""}`}
              draggable onDragStart={(event) => startDrag(event, chat)} onDragEnd={endDrag}>
              <button className="fb-open-item" aria-label={`Open conversation: ${chat.title}`} aria-current={chat.id === currentChatId ? "page" : undefined}
                onClick={() => { onSelect(chat.id); onClose(); }}
                onKeyDown={(event) => { if (event.key === "F2") { event.preventDefault(); onRenameChat(chat); } }}>
                <span className="fb-doc-icon" aria-hidden="true"><MessageSquare size={19} /><span /><span /></span>
                <span className="fb-card-text"><span className="fb-card-label" title={chat.title}>{chat.title}</span><span className="fb-card-meta" title={search ? pathFor(chat.folderId) : undefined}>{search ? pathFor(chat.folderId) : new Date(chat.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span></span>
                {chat.id === currentChatId && <span className="fb-current-badge">Open</span>}
              </button>
              <button className="fb-rename" aria-label={`Rename conversation: ${chat.title}`} title="Rename conversation (F2)" onClick={() => onRenameChat(chat)}><Pencil size={13} /></button>
            </div>)}
          </div>
        </section>}

        {!itemCount && <div className={`fb-empty${dropTarget === (folderId ?? "__root__") ? " is-drop-target" : ""}`}
          onDragOver={(event) => dragOver(event, folderId)} onDragLeave={dragLeave} onDrop={(event) => drop(event, folderId)}>
          {search ? <Search size={25} /> : <Folder size={28} />}
          <h3>{search ? "No matches found" : folderId ? "Room for a new thought" : "Your library starts here"}</h3>
          <p>{search ? "Try a different conversation or folder name." : "Add a conversation or drop one into this folder."}</p>
          {search ? <Button variant="ghost" size="sm" onClick={() => setQuery("")}>Clear search</Button> : <Button variant="outline" size="sm" onClick={() => { onNewChat(folderId); onClose(); }}><Plus size={14} />New conversation</Button>}
        </div>}
      </div>
      <div className="fb-footer"><span>Drag conversations into folders to organize them.</span>
        {onRestoreDemo && <Button variant="ghost" size="sm" className="fb-demo-restore" aria-label="Restore demo library" title="Restore missing prewritten folders and chats without deleting or overwriting your conversations." disabled={restoringDemo || restoreDisabled} onClick={onRestoreDemo}><RotateCcw size={12} />{restoringDemo ? "Restoring…" : "Restore demos"}</Button>}
        <span><kbd>F2</kbd> Rename <kbd>Esc</kbd> Close</span></div>
    </DialogContent>
  </Dialog>;
}
