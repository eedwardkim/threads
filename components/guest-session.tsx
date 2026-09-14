"use client";

import { useEffect, useState } from "react";
import { clearPrivateClientState } from "@/lib/client-state";
import { Button } from "./ui/button";

export function GuestSession({ expiresAt, onEnd }: { expiresAt: number; onEnd: () => Promise<void> }) {
  const [minutes, setMinutes] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let ended = false;
    const check = () => {
      if (ended) return;
      const remaining = expiresAt - Date.now();
      setMinutes(Math.max(0, Math.ceil(remaining / 60000)));
      if (remaining <= 0) {
        ended = true;
        clearPrivateClientState();
        void fetch("/auth/signout", {
          method: "POST", headers: { Accept: "application/json" }, signal: AbortSignal.timeout(5000),
        }).catch(() => {}).finally(() => window.location.replace("/login?error=Guest%20session%20expired."));
      }
    };
    check();
    const interval = window.setInterval(check, 1000);
    window.addEventListener("focus", check);
    return () => { window.clearInterval(interval); window.removeEventListener("focus", check); };
  }, [expiresAt]);

  return <aside className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-muted px-4 py-2 text-xs" aria-label="Guest session">
    <span>Temporary guest · {minutes === null ? "1-hour limit" : `${minutes} min left`}. Chats are automatically deleted after expiry.</span>
    <Button size="sm" variant="outline" disabled={busy} onClick={async () => {
      setBusy(true);
      try { await onEnd(); } finally { setBusy(false); }
    }}>End guest session</Button>
  </aside>;
}
