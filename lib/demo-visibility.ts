import type { Chat, Folder } from "./types";

export function visibleLibrary(chats: Chat[], folders: Folder[], showDemos: boolean) {
  if (showDemos) return { chats, folders };
  const visibleFolders = folders.filter((folder) => folder.demoKey === null);
  const folderIds = new Set(visibleFolders.map((folder) => folder.id));
  return {
    chats: chats.filter((chat) => chat.demoKey === null).map((chat) => ({
      ...chat, folderId: chat.folderId && folderIds.has(chat.folderId) ? chat.folderId : null,
    })),
    folders: visibleFolders.map((folder) => ({
      ...folder, parentId: folder.parentId && folderIds.has(folder.parentId) ? folder.parentId : null,
    })),
  };
}
