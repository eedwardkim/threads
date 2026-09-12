export const CHAT_DRAG_MIME = "application/x-threads-chat";

const MESSAGE_SQUARE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`;

export function isChatDrag(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types).includes(CHAT_DRAG_MIME);
}

export function setChatDragImage(dataTransfer: DataTransfer, title: string): () => void {
  const ghost = document.createElement("div");
  ghost.className = "chat-drag-ghost";
  const icon = document.createElement("div");
  icon.className = "chat-drag-ghost-icon";
  icon.innerHTML = MESSAGE_SQUARE_SVG;
  const label = document.createElement("span");
  label.textContent = title;
  ghost.append(icon, label);
  document.body.appendChild(ghost);
  // Force synchronous layout so the browser can snapshot the element
  const w = ghost.offsetWidth;
  // Center the cursor on the icon tile: padding-top (10px) + half the icon height
  const y = Math.round(10 + icon.offsetHeight / 2);
  const x = Math.round(w / 2);
  try {
    dataTransfer.setDragImage(ghost, x, y);
  } catch {}
  return () => ghost.remove();
}
