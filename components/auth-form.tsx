"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Logo } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { supabaseBrowser } from "@/lib/auth/client";
import { clearPrivateClientState } from "@/lib/client-state";
import { requestJson } from "@/lib/client-api";
import Link from "next/link";

type Mode = "signin" | "signup" | "recover";

const TITLES: Record<Mode, string> = { signin: "Sign in to Threads", signup: "Create your account", recover: "Reset your password" };

function callbackUrl(next: string): string {
  return `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`;
}

export function AuthForm({ next, initialError, initialMode, googleEnabled }: { next: string; initialError: string | null; initialMode: Mode; googleEnabled: boolean }) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>(initialMode);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(initialError);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const supabase = supabaseBrowser();
      if (mode === "signin") {
        const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
        if (signInError) throw signInError;
        clearPrivateClientState();
        router.replace(next);
        router.refresh();
        return;
      }
      if (mode === "signup") {
        const { data, error: signUpError } = await supabase.auth.signUp({ email, password, options: { emailRedirectTo: callbackUrl(next) } });
        if (signUpError) throw signUpError;
        if (data.session) {
          clearPrivateClientState();
          router.replace(next);
          router.refresh();
          return;
        }
        setNotice("Check your email to confirm your account, then sign in.");
        setMode("signin");
        return;
      }
      const { error: resetError } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent("/auth/reset")}` });
      if (resetError) throw resetError;
      setNotice("If that address has an account, a recovery link is on its way.");
      setMode("signin");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function google() {
    setBusy(true);
    setError(null);
    const { error: oauthError } = await supabaseBrowser().auth.signInWithOAuth({ provider: "google", options: { redirectTo: callbackUrl(next) } });
    if (oauthError) {
      setError(oauthError.message);
      setBusy(false);
    }
  }

  async function guest() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const supabase = supabaseBrowser();
      const { data: current } = await supabase.auth.getUser();
      if (current.user && !current.user.is_anonymous) throw new Error("You are already signed in.");
      if (!current.user) {
        const { error: signInError } = await supabase.auth.signInAnonymously();
        if (signInError) throw new Error("Guest access is unavailable. Please sign in or try again later.");
      }
      await requestJson("/auth/guest", { method: "POST" });
      clearPrivateClientState();
      router.replace(next);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Guest access is unavailable.");
      setBusy(false);
    }
  }

  return (
    <main className="auth-shell">
      <form className="auth-card" onSubmit={submit} aria-busy={busy}>
        <div className="auth-brand"><Logo size={26} /><span>Threads</span></div>
        <h1>{TITLES[mode]}</h1>
        {notice ? <p className="auth-notice" role="status">{notice}</p> : null}
        {error ? <p className="auth-error" role="alert">{error}</p> : null}
        <label className="auth-field">
          <span>Email</span>
          <input type="email" name="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} />
        </label>
        {mode !== "recover" ? (
          <label className="auth-field">
            <span>Password</span>
            <input type="password" name="password" minLength={8} required autoComplete={mode === "signup" ? "new-password" : "current-password"} value={password} onChange={(event) => setPassword(event.target.value)} />
          </label>
        ) : null}
        <Button type="submit" disabled={busy} className="auth-submit">
          {mode === "signin" ? "Sign in" : mode === "signup" ? "Create account" : "Send recovery link"}
        </Button>
        {googleEnabled && mode !== "recover" ? <Button type="button" variant="outline" disabled={busy} onClick={google} className="auth-submit">Continue with Google</Button> : null}
        {mode !== "recover" ? <>
          <Button type="button" variant="outline" disabled={busy} onClick={() => void guest()} className="auth-submit">Continue as guest</Button>
          <p className="auth-notice">No account needed. Guest chats expire after 1 hour and are deleted within about a minute of expiry. Use End guest session to delete them immediately.</p>
        </> : null}
        <div className="auth-links">
          <Link href="/welcome">Explore Threads</Link>
          {mode !== "signin" ? <button type="button" onClick={() => setMode("signin")}>Have an account? Sign in</button> : null}
          {mode !== "signup" ? <button type="button" onClick={() => setMode("signup")}>New here? Create an account</button> : null}
          {mode !== "recover" ? <button type="button" onClick={() => setMode("recover")}>Forgot your password?</button> : null}
        </div>
      </form>
    </main>
  );
}

export function PasswordResetForm({ email }: { email: string | null }) {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const { error: updateError } = await supabaseBrowser().auth.updateUser({ password });
    if (updateError) {
      setError(updateError.message);
      setBusy(false);
      return;
    }
    router.replace("/");
    router.refresh();
  }

  return (
    <main className="auth-shell">
      <form className="auth-card" onSubmit={submit} aria-busy={busy}>
        <div className="auth-brand"><Logo size={26} /><span>Threads</span></div>
        <h1>Choose a new password</h1>
        {email ? <p className="auth-notice">Signed in as {email}</p> : null}
        {error ? <p className="auth-error" role="alert">{error}</p> : null}
        <label className="auth-field">
          <span>New password</span>
          <input type="password" name="password" minLength={8} required autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} />
        </label>
        <Button type="submit" disabled={busy} className="auth-submit">Save password</Button>
      </form>
    </main>
  );
}
