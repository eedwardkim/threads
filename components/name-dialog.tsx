"use client";

import { useEffect, useId, useRef, useState } from "react";
import { errorText } from "@/lib/client-api";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";

export function NameDialog({ title, description, label, initialValue = "", submitLabel = "Save name", onSave, onClose }: {
  title: string;
  description: string;
  label: string;
  initialValue?: string;
  submitLabel?: string;
  onSave: (name: string) => Promise<void>;
  onClose: () => void;
}) {
  const id = useId();
  const [name, setName] = useState(initialValue);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const saving = useRef(false);
  const previousFocus = useRef<HTMLElement | null>(null);

  useEffect(() => { if (error) inputRef.current?.focus(); }, [error]);

  async function save() {
    const trimmed = name.trim();
    if (!trimmed || saving.current) return;
    if (trimmed === initialValue) { onClose(); return; }
    saving.current = true;
    setPending(true);
    setError(null);
    try {
      await onSave(trimmed);
      onClose();
    } catch (error) {
      setError(errorText(error));
    } finally {
      saving.current = false;
      setPending(false);
    }
  }

  return <Dialog open onOpenChange={(open) => { if (!open && !saving.current) onClose(); }}>
    <DialogContent className="name-dialog" onOpenAutoFocus={(event) => {
      event.preventDefault();
      previousFocus.current = document.activeElement as HTMLElement;
      inputRef.current?.focus();
      inputRef.current?.select();
    }} onCloseAutoFocus={(event) => {
      event.preventDefault();
      if (previousFocus.current?.isConnected) previousFocus.current.focus();
    }}>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>
      <form onSubmit={(event) => { event.preventDefault(); void save(); }} aria-busy={pending}>
        <label className="name-field-label" htmlFor={id}>{label}</label>
        <input ref={inputRef} id={id} className="name-field" value={name} disabled={pending} autoComplete="off" required
          aria-invalid={Boolean(error)} aria-describedby={error ? `${id}-error` : undefined}
          onChange={(event) => { setName(event.target.value); setError(null); }}
          onKeyDown={(event) => { if (event.key === "Enter" && event.nativeEvent.isComposing) event.preventDefault(); }} />
        {error && <p className="name-error" id={`${id}-error`} role="alert">{error}</p>}
        <div className="dialog-actions">
          <Button type="button" variant="ghost" onClick={onClose} disabled={pending}>Cancel</Button>
          <Button type="submit" disabled={pending || !name.trim()}>{pending ? "Saving…" : submitLabel}</Button>
        </div>
      </form>
    </DialogContent>
  </Dialog>;
}
