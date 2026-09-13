"use client";

import { useRef, useState } from "react";
import { Check, Folder as FolderIcon, FolderInput, FolderPlus, Inbox, Library, Search } from "lucide-react";
import type { Folder } from "@/lib/types";
import { errorText } from "@/lib/client-api";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";
import { NameDialog } from "./name-dialog";

function folderPath(folder: Folder, map: Map<string, Folder>): string {
  const names = [folder.name];
  const seen = new Set([folder.id]);
  let parent = folder.parentId ? map.get(folder.parentId) : undefined;
  while (parent && !seen.has(parent.id)) {
    seen.add(parent.id);
    names.unshift(parent.name);
    parent = parent.parentId ? map.get(parent.parentId) : undefined;
  }
  return names.join(" / ");
}

export function MoveToDialog({ folders, currentFolderId, itemType = "conversation", onMove, onCreateFolder, onClose }: {
  folders: Folder[];
  currentFolderId: string | null;
  itemType?: "conversation" | "folder";
  onMove: (folderId: string | null) => Promise<void>;
  onCreateFolder: (name: string) => Promise<Folder>;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const moving = useRef(false);
  const folderMap = new Map(folders.map((folder) => [folder.id, folder]));
  const filtered = folders.map((folder) => ({ folder, path: folderPath(folder, folderMap) }))
    .filter(({ path }) => path.toLowerCase().includes(query.trim().toLowerCase()))
    .sort((a, b) => a.path.localeCompare(b.path));

  async function move(folderId: string | null) {
    if (moving.current) return;
    if (folderId === currentFolderId) { onClose(); return; }
    moving.current = true;
    setPending(true);
    setError(null);
    try {
      await onMove(folderId);
      onClose();
    } catch (error) {
      setError(errorText(error));
    } finally {
      moving.current = false;
      setPending(false);
    }
  }

  return <>
    <Dialog open onOpenChange={(open) => { if (!open && !moving.current) onClose(); }}>
      <DialogContent className="move-to-dialog">
        <span className="move-to-icon" aria-hidden="true"><FolderInput size={21} /></span>
        <DialogHeader>
          <DialogTitle>Move to folder</DialogTitle>
          <DialogDescription>Choose a new home for this {itemType}.</DialogDescription>
        </DialogHeader>
        <div className="fb-search"><Search size={15} /><input autoFocus aria-label="Find a folder" placeholder="Find a folder…" value={query} onChange={(event) => setQuery(event.target.value)} /></div>
        <ul className="move-to-results" aria-label="Folders" aria-busy={pending}>
          <li><button aria-current={currentFolderId === null ? "true" : undefined} className={currentFolderId === null ? "is-active" : ""} disabled={pending} onClick={() => void move(null)}>
            {itemType === "folder" ? <Library size={17} /> : <Inbox size={17} />}<span className="move-to-label"><strong>{itemType === "folder" ? "Library" : "Unsorted"}</strong><small>Top level</small></span>{currentFolderId === null && <Check size={14} />}
          </button></li>
          {filtered.map(({ folder, path }) => <li key={folder.id}><button aria-current={currentFolderId === folder.id ? "true" : undefined} className={currentFolderId === folder.id ? "is-active" : ""} disabled={pending} onClick={() => void move(folder.id)}>
            <FolderIcon size={17} /><span className="move-to-label"><strong>{folder.name}</strong><small title={path}>{folder.parentId && folderMap.has(folder.parentId) ? folderPath(folderMap.get(folder.parentId)!, folderMap) : "Library"}</small></span>{currentFolderId === folder.id && <Check size={14} />}
          </button></li>)}
          {!filtered.length && query && <li className="move-to-empty">No folders match your search.</li>}
        </ul>
        {error && <p className="name-error" role="alert">{error}</p>}
        <div className="move-to-footer"><Button variant="ghost" size="sm" onClick={() => setCreating(true)} disabled={pending}><FolderPlus size={15} />New folder</Button><span aria-live="polite">{pending ? "Moving…" : "Select a destination"}</span></div>
      </DialogContent>
    </Dialog>
    {creating && <NameDialog title="New folder" description="Create a folder in your library, then move this item into it." label="Folder name" submitLabel="Create & move" onClose={() => setCreating(false)} onSave={async (name) => {
      const folder = await onCreateFolder(name);
      await move(folder.id);
    }} />}
  </>;
}
