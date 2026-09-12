"use client";

import { useCallback, useEffect, useState } from "react";
import { CornerUpLeft } from "lucide-react";
import { toast } from "sonner";
import { mapSelectionToSource } from "@/lib/markdown-offsets";
import type { Message } from "@/lib/types";
import { Button } from "./ui/button";

export interface SpanSelection {
  parentMessageId: string;
  anchorStart: number;
  anchorEnd: number;
  anchorExact: string;
  x: number;
  y: number;
}

export function SelectionReply({ messages, locked, onReply }: { messages: Message[]; locked: boolean; onReply: (selection: SpanSelection) => void }) {
  const [selected, setSelected] = useState<SpanSelection | null>(null);
  const capture = useCallback(() => {
    if (locked) return null;
    const selection = window.getSelection();
    if (!selection?.rangeCount || selection.isCollapsed || !selection.toString().trim()) return null;
    const range = selection.getRangeAt(0);
    const element = range.startContainer.nodeType === Node.ELEMENT_NODE ? range.startContainer as Element : range.startContainer.parentElement;
    const article = element?.closest<HTMLElement>('[data-message-id][data-role="assistant"][data-complete="true"][data-scope="main"]');
    const root = article?.querySelector<HTMLElement>("[data-markdown-root]");
    const message = messages.find((item) => item.id === article?.dataset.messageId);
    if (!message?.complete || !root?.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
    try {
      const anchor = mapSelectionToSource(root, range, message.content);
      const rect = range.getBoundingClientRect();
      return { ...anchor, parentMessageId: message.id, x: Math.max(66, Math.min(window.innerWidth - 66, rect.left + rect.width / 2)), y: rect.top > 52 ? rect.top - 45 : rect.bottom + 9 };
    } catch {
      toast.error("This selection cannot be mapped safely. Try a different passage.");
      return null;
    }
  }, [messages, locked]);

  const reply = useCallback((value: SpanSelection) => {
    setSelected(null);
    window.getSelection()?.removeAllRanges();
    onReply(value);
  }, [onReply]);

  useEffect(() => {
    const update = () => setSelected(capture());
    const clear = () => setSelected(null);
    const changed = () => { if (window.getSelection()?.isCollapsed) clear(); };
    const key = (event: KeyboardEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (event.key.toLowerCase() === "r" && !event.metaKey && !event.ctrlKey && !event.altKey && !target?.closest("input, textarea, [contenteditable=true]")) {
        const value = capture();
        if (value) { event.preventDefault(); reply(value); }
      }
      if (event.key === "Escape") { window.getSelection()?.removeAllRanges(); clear(); }
    };
    document.addEventListener("mouseup", update);
    document.addEventListener("keyup", update);
    document.addEventListener("selectionchange", changed);
    document.addEventListener("scroll", clear, true);
    window.addEventListener("keydown", key);
    window.addEventListener("resize", clear);
    return () => {
      document.removeEventListener("mouseup", update);
      document.removeEventListener("keyup", update);
      document.removeEventListener("selectionchange", changed);
      document.removeEventListener("scroll", clear, true);
      window.removeEventListener("keydown", key);
      window.removeEventListener("resize", clear);
    };
  }, [capture, reply]);

  if (!selected || locked) return null;
  return <div className="selection-toolbar" style={{ left: selected.x, top: selected.y }} role="toolbar" aria-label="Selected passage">
    <Button onMouseDown={(event) => event.preventDefault()} onClick={() => reply(selected)} aria-label="Reply to selected passage"><CornerUpLeft size={15} />Reply<kbd>R</kbd></Button>
  </div>;
}
