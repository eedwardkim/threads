import { registerPrivateState } from "./client-state";

const PREFIX = "threads:entry:";
const MAX_AGE = 5 * 60_000;

registerPrivateState(() => {
  try {
    for (const key of Object.keys(sessionStorage)) {
      if (key.startsWith(PREFIX)) sessionStorage.removeItem(key);
    }
  } catch {}
});

export function saveEntryPrompt(userId: string, chatId: string, prompt: string): void {
  sessionStorage.setItem(PREFIX + chatId, JSON.stringify({ userId, prompt, createdAt: Date.now() }));
}

export function takeEntryPrompt(userId: string | null, chatId: string): string | null {
  try {
    const raw = sessionStorage.getItem(PREFIX + chatId);
    sessionStorage.removeItem(PREFIX + chatId);
    if (!raw || !userId) return null;
    const entry: unknown = JSON.parse(raw);
    if (!entry || typeof entry !== "object"
      || !("userId" in entry) || entry.userId !== userId
      || !("createdAt" in entry) || typeof entry.createdAt !== "number"
      || entry.createdAt > Date.now() || Date.now() - entry.createdAt > MAX_AGE
      || !("prompt" in entry) || typeof entry.prompt !== "string"
      || entry.prompt.length > 4000) return null;
    return entry.prompt.trim() || null;
  } catch {
    return null;
  }
}
