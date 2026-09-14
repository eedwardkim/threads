"use client";

import { useEffect, useState } from "react";

export const THINKING_PHRASES = [
  "Stringing things together",
  "Tying up loose ends",
  "Following the thread",
  "Pulling on a few strings",
  "Untangling the knot",
  "Weaving an answer",
  "Threading the needle",
  "Spinning a good yarn",
  "Picking up the thread",
  "Knitting it together",
];

const ROTATE_MS = 2400;
const STRAND = "M4 23C10 25 27 13 25 7C23 1 10 13 10 22C10 29 17 29 22 23L28 16";

/** The logo strand drawing itself, with a bright pulse snaking along its own path. */
export function ThinkingStrand({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true" className="thinking-strand">
      <path d={STRAND} className="thinking-strand-base" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" />
      <path d={STRAND} className="thinking-strand-pulse" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Shown while a model is working before its first token arrives. Phrases rotate; screen readers get one stable status. */
export function ThinkingIndicator({ label = "Thinking" }: { label?: string }) {
  const [index, setIndex] = useState(() => Math.floor(Math.random() * THINKING_PHRASES.length));
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const timer = window.setInterval(() => setIndex((current) => (current + 1) % THINKING_PHRASES.length), ROTATE_MS);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <div className="thinking-state" role="status" aria-label={label}>
      <ThinkingStrand />
      <span className="thinking-phrase" key={index} aria-hidden="true">{THINKING_PHRASES[index]}…</span>
    </div>
  );
}
