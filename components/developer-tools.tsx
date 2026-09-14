"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { requestJson } from "@/lib/client-api";
import { clearPrivateClientState } from "@/lib/client-state";
import { Button } from "./ui/button";

export function DeveloperToolsShortcut() {
  const router = useRouter();
  useEffect(() => {
    const open = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.altKey && event.code === "KeyD" && !event.repeat) {
        event.preventDefault();
        router.push("/dev-tools");
      }
    };
    window.addEventListener("keydown", open);
    return () => window.removeEventListener("keydown", open);
  }, [router]);
  return null;
}

export function DeveloperTools({ enabled }: { enabled: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function change(action: "restore" | "show" | "hide") {
    setBusy(true);
    setError(null);
    try {
      await requestJson("/api/demo", { method: "POST", body: JSON.stringify({ action }) });
      clearPrivateClientState();
      window.location.assign(new URL("/", window.location.origin).href);
    } catch {
      setError("Could not update demo visibility. Please try again.");
      setBusy(false);
    }
  }

  return <main className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center gap-6 p-6">
    <Link href="/" className="text-sm text-muted-foreground underline">Back to chats</Link>
    <header>
      <p className="text-sm text-muted-foreground">Development and live demos</p>
      <h1 className="text-2xl font-semibold">Developer tools</h1>
    </header>
    <section className="grid gap-4 rounded-xl border border-border p-6" aria-labelledby="demo-title">
      <h2 id="demo-title" className="font-medium">Prewritten demo library</h2>
      <p className="text-sm text-muted-foreground">Demo conversations are {enabled ? "visible" : "hidden"} for your account. Hiding keeps your edits and follow-ups saved. Your own conversations remain available.</p>
      <Button disabled={busy} onClick={() => void change(enabled ? "hide" : "show")}>{enabled ? "Hide demo library" : "Show saved demos"}</Button>
      <Button variant="outline" disabled={busy} onClick={() => void change("restore")}>Restore and show demo library</Button>
      <p className="text-sm text-muted-foreground">Restore adds missing demos without overwriting existing conversations. Prewritten contents load only when opened.</p>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {busy && <p role="status" className="text-sm">Updating demo library…</p>}
    </section>
    <p className="text-xs text-muted-foreground">Open these tools with Ctrl + Alt + D from a chat.</p>
  </main>;
}
