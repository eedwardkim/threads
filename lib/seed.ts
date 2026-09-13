import type { ChatRepository } from "./db/repository";
import { DEMO_FOLDERS, demoChat, type DemoConversation } from "./demo-catalog";
import type { FrozenContext, Message } from "./types";

export function seedDatabase(repository: ChatRepository) {
  return repository.restoreDemoCatalog(DEMO_FOLDERS);
}

async function loadConversation(id: string, folderId: string): Promise<DemoConversation> {
  const library = folderId === "demo-folder-linear-algebra" ? await import("./demo-linear-algebra")
    : folderId === "demo-folder-bernstein" ? await import("./demo-bernstein")
      : folderId === "demo-folder-psychology" ? await import("./demo-psychology")
        : DEMO_FOLDERS[3].chats.slice(0, 6).some((chat) => chat.id === id) ? await import("./demo-cs61a-core")
          : await import("./demo-cs61a-functions");
  const conversation = library.conversations.find((chat) => chat.id === id);
  if (!conversation) throw new Error(`Missing demo conversation: ${id}`);
  return conversation;
}

export async function ensureDemoChat(repository: ChatRepository, id: string): Promise<void> {
  const entry = demoChat(id);
  if (!entry || !repository.getChat(id) || repository.hasMessages(id)) return;
  const conversation = await loadConversation(id, entry.folder.id);
  repository.seedChat(id, () => {
    let createdAt = entry.chat.createdAt;
    const decisions: string[] = [];
    const append = (role: Message["role"], content: string, threadId: string | null = null) => repository.appendMessage({
      chatId: id, threadId, role, content, modelKey: null, complete: true, createdAt: createdAt += 60_000,
    }, { preserveTimestamp: true });

    for (const exchange of conversation.exchanges) {
      append("user", exchange.user);
      const parent = append("assistant", exchange.assistant);
      for (const branch of exchange.threads) {
        const anchorStart = parent.content.indexOf(branch.quote);
        if (!branch.quote || anchorStart < 0 || parent.content.lastIndexOf(branch.quote) !== anchorStart) {
          throw new Error(`Demo anchor must match exactly once: ${branch.title}`);
        }
        const context: FrozenContext = {
          kind: "compressed",
          briefing: {
            goal: conversation.goal,
            constraints: ["Prewritten educational example; distinguish worked results from open study questions.", "Keep this side discussion separate from the main conversation."],
            decisions: [...decisions],
            artifacts: conversation.sources,
            open_questions: [branch.exchanges[0].user],
          },
        };
        const thread = repository.insertThread({
          parentMessageId: parent.id, anchorStart, anchorEnd: anchorStart + branch.quote.length,
          source: "user", title: branch.title, compressedContext: JSON.stringify(context),
          contextFrozenAt: parent.createdAt, createdAt: createdAt += 30_000,
        });
        for (const reply of branch.exchanges) {
          append("user", reply.user, thread.id);
          append("assistant", reply.assistant, thread.id);
        }
        if (branch.resolved) repository.updateThread(thread.id, { resolved: true });
      }
      decisions.push(exchange.summary);
    }
  });
}
