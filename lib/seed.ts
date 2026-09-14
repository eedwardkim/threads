import { randomUUID } from "node:crypto";
import type { ChatRepository, DemoCatalogFolder, DemoHydrationPlan } from "./db/repository";
import { DEMO_FOLDERS, DEMO_SEED_KEY, demoChat, type DemoConversation } from "./demo-catalog";
import type { FrozenContext, Message } from "./types";

export function demoCatalog(): DemoCatalogFolder[] {
  return DEMO_FOLDERS.map((folder) => ({
    key: folder.id, name: folder.name, chats: folder.chats.map((chat) => ({ key: chat.id, title: chat.title, createdAt: chat.createdAt })),
  }));
}

/** Creates this user's missing demo folders/chats (contents stay lazy). Idempotent and race-safe. */
export function seedDatabase(repository: ChatRepository) {
  return repository.restoreDemoCatalog(demoCatalog(), DEMO_SEED_KEY);
}

/** First sign-in: give the user the study library once, without touching an existing library. */
export async function seedIfNeeded(repository: ChatRepository): Promise<void> {
  if ((await repository.demoSeedKey()) !== DEMO_SEED_KEY) await seedDatabase(repository);
}

async function loadConversation(key: string, folderKey: string): Promise<DemoConversation> {
  const library = folderKey === "demo-folder-linear-algebra" ? await import("./demo-linear-algebra")
    : folderKey === "demo-folder-bernstein" ? await import("./demo-bernstein")
      : folderKey === "demo-folder-psychology" ? await import("./demo-psychology")
        : DEMO_FOLDERS[3].chats.slice(0, 6).some((chat) => chat.id === key) ? await import("./demo-cs61a-core")
          : await import("./demo-cs61a-functions");
  const conversation = library.conversations.find((chat) => chat.id === key);
  if (!conversation) throw new Error(`Missing demo conversation: ${key}`);
  return conversation;
}

/** Builds the whole fixture graph in memory so hydration is a few bulk inserts. */
export function planDemoConversation(conversation: DemoConversation, startedAt: number): DemoHydrationPlan {
  const plan: DemoHydrationPlan = { messages: [], threads: [] };
  let createdAt = startedAt;
  const decisions: string[] = [];
  const append = (role: Message["role"], content: string, threadId: string | null = null) => {
    const message = { id: randomUUID(), threadId, role, content, createdAt: createdAt += 60_000 };
    plan.messages.push(message);
    return message;
  };
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
      const thread = {
        id: randomUUID(), parentMessageId: parent.id, anchorStart, anchorEnd: anchorStart + branch.quote.length, anchorExact: branch.quote,
        compressedContext: JSON.stringify(context), contextFrozenAt: parent.createdAt, title: branch.title, resolved: branch.resolved,
        createdAt: createdAt += 30_000,
      };
      plan.threads.push(thread);
      for (const reply of branch.exchanges) {
        append("user", reply.user, thread.id);
        append("assistant", reply.assistant, thread.id);
      }
    }
    decisions.push(exchange.summary);
  }
  return plan;
}

/** Lazily fills a demo chat the first time it is opened; concurrent instances hydrate it once. */
export async function ensureDemoChat(repository: ChatRepository, chatId: string): Promise<void> {
  const chat = await repository.getChat(chatId);
  if (!chat?.demoKey) return;
  const entry = demoChat(chat.demoKey);
  if (!entry || (await repository.hasMessages(chatId))) return;
  const conversation = await loadConversation(entry.chat.id, entry.folder.id);
  await repository.hydrateDemoChat(chatId, () => planDemoConversation(conversation, entry.chat.createdAt));
}
