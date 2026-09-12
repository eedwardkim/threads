"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

export function CopyButton({ text, label = "Copy message", showLabel = false }: { text: string | (() => string); label?: string; showLabel?: boolean }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(typeof text === "function" ? text() : text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      toast.error("Could not copy. Check your browser's clipboard permission.");
    }
  }
  return (
    <Button type="button" variant="ghost" size={showLabel ? "sm" : "icon"} className="copy-button" aria-label={copied ? "Copied" : label} title={copied ? "Copied" : label} onClick={copy}>
      {copied ? <Check /> : <Copy />}
      {showLabel && <span>{copied ? "Copied" : "Copy"}</span>}
    </Button>
  );
}
