import { ChatApp } from "@/components/chat-app";
import { getRepository } from "@/lib/db/repository";
import { getProviderStatus } from "@/lib/provider";
import { getThreadData } from "@/lib/thread-service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function Page({ searchParams }: { searchParams: Promise<{ chat?: string; thread?: string }> }) {
  const params = await searchParams;
  const repository = getRepository();
  const chats = repository.listChats();
  const chat = chats.find((item) => item.id === params.chat) ?? chats[0];
  const current = chat ? { chat, messages: repository.listMessages(chat.id), threads: repository.listThreads(chat.id) } : null;
  const initialThread = params.thread && current?.threads.some((thread) => thread.id === params.thread) ? getThreadData(params.thread) : null;
  return <ChatApp initialData={{ chats, current }} initialThread={initialThread} providerStatus={getProviderStatus()} />;
}
