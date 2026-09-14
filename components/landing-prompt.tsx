"use client";

import { useRef, useState } from "react";
import { ArrowUp, ArrowUpRight } from "lucide-react";
import { Button } from "./ui/button";
import styles from "@/app/welcome/welcome.module.css";

const suggestions = [
  ["Untangle an idea", "Explain string theory like I’m curious, not a physicist."],
  ["Take a different angle", "Help me look at a difficult decision from a different perspective."],
  ["Make something click", "Teach me something surprising, one small step at a time."],
];

export function LandingPrompt() {
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState("");
  const textarea = useRef<HTMLTextAreaElement>(null);

  function start() {
    if (!prompt.trim()) return;
    const tab = window.open("about:blank", "_blank");
    if (!tab) {
      setError("Your browser blocked the new tab. Allow pop-ups for this site, then try again.");
      return;
    }
    tab.opener = null;
    tab.location.replace(`/auth/start#${encodeURIComponent(prompt.trim())}`);
    setError("");
  }

  return <>
    <form className={styles.prompt} onSubmit={(event) => { event.preventDefault(); start(); }}>
      <label className="sr-only" htmlFor="first-thought">What’s on your mind?</label>
      <textarea id="first-thought" ref={textarea} rows={2} maxLength={4000} value={prompt}
        placeholder="What’s on your mind?" onChange={(event) => setPrompt(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            start();
          }
        }} />
      <div className={styles.controls}><span>Try as a guest <ArrowUpRight size={12} /> Opens in a new tab</span>
        <Button type="submit" size="icon" className={styles.send} aria-label="Start guest conversation in a new tab" disabled={!prompt.trim()}><ArrowUp size={20} /></Button>
      </div>
    </form>
    {error && <p className={styles.error} role="alert">{error}</p>}
    <div className={styles.suggestions}>{suggestions.map(([label, text]) => <Button key={label} type="button" variant="ghost"
      onClick={() => { setPrompt(text); textarea.current?.focus(); }}>{label}</Button>)}</div>
  </>;
}
