"use client";

import { useEffect, useRef, useState } from "react";
import { CornerDownRight, Search, X } from "lucide-react";
import { requestJson, errorText } from "@/lib/client-api";
import type { SearchResult } from "@/lib/types";
import { Button } from "./ui/button";

function Excerpt({ text, query }: { text: string; query: string }) {
  const compact = text.replace(/\s+/g, " ");
  const index = compact.toLowerCase().indexOf(query.toLowerCase());
  const start = Math.max(0, index - 18);
  return <span className="search-excerpt">{start > 0 ? "…" : ""}{compact.slice(start, Math.max(start, index))}{index >= 0 && <mark>{compact.slice(index, index + query.length)}</mark>}{compact.slice(index >= 0 ? index + query.length : start)}</span>;
}

export function SearchPanel({ chatId, onClose, onSelect }: { chatId: string | null; onClose: () => void; onSelect: (result: SearchResult) => void }) {
  const [query, setQuery] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ chatId: string; query: string; items: SearchResult[]; error?: string }>({ chatId: "", query: "", items: [] });
  const input = useRef<HTMLInputElement>(null);
  const term = query.trim();
  const pending = Boolean(term && chatId && (result.query !== term || result.chatId !== chatId));
  const items = !pending && term ? result.items : [];

  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => {
    if (!chatId || !term) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void requestJson<{ results: SearchResult[] }>(`/api/search?chatId=${encodeURIComponent(chatId)}&q=${encodeURIComponent(term)}`, { signal: controller.signal })
        .then((data) => setResult({ chatId, query: term, items: data.results }))
        .catch((error) => { if (!controller.signal.aborted) setResult({ chatId, query: term, items: [], error: errorText(error) }); });
    }, 180);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [chatId, term, attempt]);

  return <section className="sidebar-search" aria-label="Search this conversation">
    <div className="search-input-row"><Search size={14} /><input ref={input} value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Search messages" placeholder="Find a phrase…" maxLength={300} disabled={!chatId} /><Button variant="ghost" size="icon" aria-label="Close search" title="Close search (Esc)" onClick={onClose}><X size={14} /></Button></div>
    <p className="search-summary" role="status">{pending ? "Searching…" : term ? `${items.length} ${items.length === 1 ? "result" : "results"}` : "Search the main chat and its threads"}</p>
    <div className="search-results">
      {!pending && result.error && term ? <div className="search-empty"><p>{result.error}</p><Button variant="outline" size="sm" onClick={() => setAttempt((value) => value + 1)}>Try again</Button></div> : items.map((item) => <button key={item.id} className="search-result" onClick={() => onSelect(item)} data-search-message={item.id}>
        <span className="search-source">{item.threadId && <CornerDownRight size={12} />}<span>{item.threadId ? item.threadTitle?.replace(/[*`#]/g, "") : "Main conversation"}</span></span>
        <Excerpt text={item.excerpt} query={term} />
      </button>)}
      {!pending && term && !items.length && !result.error && <p className="search-empty">No matches in this conversation.</p>}
      {!term && <div className="search-empty"><p>Find a thought, wherever<br />the conversation took it.</p><span>Press Esc to return.</span></div>}
    </div>
  </section>;
}
