"use client";

import { memo, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import ReactMarkdown, { type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import { rehypeSourcePositions } from "@/lib/markdown-offsets";
import type { Thread } from "@/lib/types";
import { CopyButton } from "./copy-button";

function CodeBlock({ children, node }: { children?: ReactNode } & ExtraProps) {
  const ref = useRef<HTMLPreElement>(null);
  const code = node?.children.find((child) => child.type === "element" && child.tagName === "code");
  const classes = code?.type === "element" ? code.properties.className : [];
  const language = (Array.isArray(classes) ? classes : []).find((name) => String(name).startsWith("language-"));
  function codeText() {
    const clone = ref.current?.querySelector("code")?.cloneNode(true) as HTMLElement | undefined;
    clone?.querySelectorAll("[data-anchor-marker], [data-md-ui]").forEach((element) => element.remove());
    return (clone?.textContent ?? "").replace(/\n$/, "");
  }
  return (
    <div className="code-frame">
      <div className="code-toolbar" data-md-ui="true">
        <span>{language ? String(language).replace("language-", "") : "Code"}</span>
        <CopyButton text={codeText} label="Copy code" showLabel />
      </div>
      <pre ref={ref}>{children}</pre>
    </div>
  );
}

const EMPTY_THREADS: Thread[] = [];

export const Markdown = memo(function Markdown({ content, anchors = EMPTY_THREADS, activeThreadId = null, onOpenThread, streaming = false, selectable = false }: {
  content: string;
  anchors?: Thread[];
  activeThreadId?: string | null;
  onOpenThread?: (id: string) => void;
  streaming?: boolean;
  selectable?: boolean;
}) {
  const root = useRef<HTMLDivElement>(null);
  const plugins = useMemo(() => [[rehypeSourcePositions, { source: content, anchors, activeThreadId }] as [typeof rehypeSourcePositions, { source: string; anchors: Thread[]; activeThreadId: string | null }]], [content, anchors, activeThreadId]);
  useLayoutEffect(() => {
    const leaves = root.current?.querySelectorAll("[data-md-start]");
    if (!streaming || !leaves?.length) return;
    const tail = leaves[leaves.length - 1];
    tail.classList.add("stream-tail");
    return () => tail.classList.remove("stream-tail");
  }, [content, streaming]);
  return (
    <div ref={root} className={`markdown${streaming ? " is-streaming" : ""}${selectable ? " is-selectable" : ""}`} data-markdown-root="true"
      onClick={(event) => {
        const target = (event.target as HTMLElement).closest<HTMLElement>("[data-thread-id]");
        if (target?.dataset.threadId && (target.dataset.anchorMarker || !window.getSelection()?.toString())) {
          event.preventDefault();
          onOpenThread?.(target.dataset.threadId);
        }
      }}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={plugins} components={{
        pre: CodeBlock,
        a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer">{children}</a>,
        h1: ({ children }) => <h2 className="md-h1">{children}</h2>,
        h2: ({ children }) => <h3 className="md-h2">{children}</h3>,
        h3: ({ children }) => <h4 className="md-h3">{children}</h4>,
      }}>{content}</ReactMarkdown>
      {streaming && !content && <span className="initial-cursor" aria-label="Writing an answer" />}
    </div>
  );
});
