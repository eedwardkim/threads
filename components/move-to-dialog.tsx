"use client";

import { useState } from "react";
import { Check, FolderPlus, Inbox, Search } from "lucide-react";
import type { Folder } from "@/lib/types";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";

function folderDepth(folder: Folder, map: Map<string, Folder>): number {
  let depth = 0;
  let current = folder;
  while (current.parentId) {
    depth++;
    const parent = map.get(current.parentId);
    if (!parent) break;
    current = parent;
  }
  return depth;
}

export function MoveToDialog({ folders, currentFolderId, onMove, onCreateFolder, onClose }: {
  folders: Folder[];
  currentFolderId: string | null;
  onMove: (folderId: string | null) => void;
  onCreateFolder: (name: string) => Promise<Folder>;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const folderMap = new Map(folders.map((f) => [f.id, f]));
  const filtered = query
    ? folders.filter((f) => f.name.toLowerCase().includes(query.toLowerCase()))
    : folders;

  async function handleNewFolder() {
    const folder = await onCreateFolder("New folder");
    onMove(folder.id);
  }

  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent className="move-to-dialog">
      <DialogHeader>
        <DialogTitle>Move to folder</DialogTitle>
        <DialogDescription>Choose a folder for this conversation.</DialogDescription>
      </DialogHeader>
      <div className="switcher-input"><Search size={16} /><input autoFocus aria-label="Find a folder" placeholder="Find a folder…" value={query} onChange={(e) => setQuery(e.target.value)} /></div>
      <div className="move-to-results" role="listbox" aria-label="Folders">
        <button role="option" aria-selected={currentFolderId === null} className={currentFolderId === null ? "is-active" : ""} onClick={() => { onMove(null); onClose(); }}>
          <Inbox size={15} /><span>Unsorted</span>{currentFolderId === null && <Check size={14} />}
        </button>
        {filtered.map((folder) => {
          const depth = folderDepth(folder, folderMap);
          return <button key={folder.id} role="option" aria-selected={currentFolderId === folder.id} className={currentFolderId === folder.id ? "is-active" : ""} style={{ paddingLeft: `${10 + depth * 16}px` }} onClick={() => { onMove(folder.id); onClose(); }}>
            <span>{folder.name}</span>{currentFolderId === folder.id && <Check size={14} />}
          </button>;
        })}
        {!filtered.length && query && <p>No folders match.</p>}
      </div>
      <button className="move-to-new-folder" onClick={() => void handleNewFolder()}>
        <FolderPlus size={15} /><span>New folder</span>
      </button>
    </DialogContent>
  </Dialog>;
}
