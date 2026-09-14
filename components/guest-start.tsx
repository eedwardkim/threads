"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { supabaseBrowser } from "@/lib/auth/client";
import { clearPrivateClientState } from "@/lib/client-state";
import { requestJson, errorText } from "@/lib/client-api";
import { saveEntryPrompt } from "@/lib/entry-prompt";
import type { Chat } from "@/lib/types";
import { Logo } from "./logo";
import { Button } from "./ui/button";

export function GuestStart() {
  const started = useRef(false);
  const prompt = useRef("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);

  async function start() {
    setBusy(true);
    setError("");
    try {
      sessionStorage.setItem("threads:storage-check", "1");
      sessionStorage.removeItem("threads:storage-check");
      const supabase = supabaseBrowser();
      const { data: current } = await supabase.auth.getUser();
      let user = current.user;
      if (user && !user.is_anonymous) throw new Error("You’re already signed in. Open the app and sign out there to start a temporary guest chat.");
      if (!user) {
        const { data, error: signInError } = await supabase.auth.signInAnonymously();
        if (signInError || !data.user) throw new Error("Guest access is unavailable. Please try again or sign in.");
        user = data.user;
      }
      if (user.is_anonymous) {
        const response = await fetch("/auth/guest", { method: "POST", cache: "no-store" });
        if (!response.ok) {
          if (response.status === 401) {
            await supabase.auth.signOut({ scope: "local" });
            throw new Error("Your previous guest session has ended. Try again to start a fresh one.");
          }
          throw new Error("We couldn’t start your guest session. Please try again.");
        }
      }
      clearPrivateClientState();
      const { chat } = await requestJson<{ chat: Chat }>("/api/chats", { method: "POST", body: "{}" });
      if (prompt.current) saveEntryPrompt(user.id, chat.id, prompt.current);
      window.location.replace(`/?chat=${encodeURIComponent(chat.id)}`);
    } catch (caught) {
      setError(errorText(caught));
      setBusy(false);
    }
  }

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    try { prompt.current = decodeURIComponent(window.location.hash.slice(1)).trim().slice(0, 4000); } catch {}
    window.history.replaceState(null, "", window.location.pathname);
    void start();
  }, []);

  return <main className="auth-shell"><div className="auth-card" aria-busy={busy}>
    <div className="auth-brand"><Logo size={34} /><span>Threads</span></div>
    <h1>{busy ? "A little room for your thought…" : "Let’s try that again."}</h1>
    {busy ? <p className="auth-description" role="status">Opening your conversation.</p> : <>
      <p className="auth-error" role="alert">{error}</p>
      <Button className="auth-submit" onClick={() => void start()}>Try again</Button>
      <Link href="/">Open the app</Link>
      <Link href="/login" className="auth-notice">Sign in instead</Link>
    </>}
  </div></main>;
}
