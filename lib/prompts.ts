import { parseFrozenContext } from "./context";
import type { Briefing, Message, PromptMessage, Thread } from "./types";

export const MAIN_SYSTEM_PROMPT = "You are a thoughtful, precise assistant. Answer the user's request directly, and use Markdown where it improves clarity. For math, use $...$ for inline expressions and $$ delimiters on separate lines for display equations, never \\(...\\) or \\[...\\].";

/** Persisted message → prompt turn. Attachment metadata rides along; bytes/digests are resolved at generation time. */
function turn({ role, content, attachments }: Message): PromptMessage {
  return attachments?.length ? { role, content, attachments } : { role, content };
}

export function assembleMainPrompt(messages: Message[]): PromptMessage[] {
  return [
    { role: "system", content: MAIN_SYSTEM_PROMPT },
    ...messages.filter((message) => message.threadId === null).map(turn),
  ];
}

export function renderBriefing(briefing: Briefing): string {
  const list = (items: string[]) => items.length ? items.map((item) => `- ${item}`).join("\n") : "(none)";
  return [
    `Goal:\n${briefing.goal}`,
    `Constraints:\n${list(briefing.constraints)}`,
    `Decisions:\n${list(briefing.decisions)}`,
    `Artifacts:\n${list(briefing.artifacts)}`,
    `Open questions:\n${list(briefing.open_questions)}`,
  ].join("\n\n");
}

function frozenContext(value: string | null): string {
  const context = parseFrozenContext(value);
  if (context === null) return "Frozen main conversation briefing:\nNo briefing is available.";
  if (context.kind === "compressed") return `Frozen main conversation briefing:\n\n${renderBriefing(context.briefing)}`;
  return `Frozen main conversation context (verbatim fallback):\n\n${context.messages.map((message, index) =>
    `--- Message ${index + 1} (${message.role}) ---\n${message.content}\n--- End message ${index + 1} ---`,
  ).join("\n\n")}`;
}

function threadConversation(thread: Thread, history: Message[]): PromptMessage[] {
  return [
    { role: "system", content: `Thread subject:\n${thread.anchorExact}` },
    ...history.filter((message) => message.threadId === thread.id && message.chatId === thread.chatId).map(turn),
  ];
}

export function assembleThreadPrompt(thread: Thread, parent: Message, history: Message[]): PromptMessage[] {
  return [
    { role: "system", content: MAIN_SYSTEM_PROMPT },
    { role: "system", content: frozenContext(thread.compressedContext) },
    { role: "assistant", content: parent.content },
    ...threadConversation(thread, history),
  ];
}

export function assembleFullThreadPrompt(thread: Thread, main: Message[], history: Message[]): PromptMessage[] {
  return [
    ...assembleMainPrompt(main.filter((message) => message.chatId === thread.chatId)),
    ...threadConversation(thread, history),
  ];
}
