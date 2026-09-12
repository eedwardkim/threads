import type { Message } from "./types";
import type { StreamSession } from "./stream-store";

export function mergeMessages(messages: Message[], session: StreamSession | undefined, chatId: string): Message[] {
  if (!session || session.chatId !== chatId) return messages;
  const merged = new Map(messages.map((message) => [message.id, message]));
  for (const incoming of [session.userMessage, session.message]) {
    if (!incoming) continue;
    const saved = merged.get(incoming.id);
    if (!saved || (!saved.complete && (session.phase !== "idle" || incoming.complete || incoming.content.length > saved.content.length))) {
      merged.set(incoming.id, incoming);
    }
  }
  return [...merged.values()].sort((a, b) => a.createdAt - b.createdAt);
}
