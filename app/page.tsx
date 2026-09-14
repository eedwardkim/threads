import { redirect } from "next/navigation";
import { ChatApp } from "@/components/chat-app";
import { currentUser } from "@/lib/auth/server";
import { dataFor } from "@/lib/db/access";
import { getProviderStatus } from "@/lib/provider";
import { ensureDemoChat, seedIfNeeded } from "@/lib/seed";
import { getThreadData } from "@/lib/thread-service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function Page({ searchParams }: { searchParams: Promise<{ chat?: string; thread?: string }> }) {
  const params = await searchParams;
  const user = await currentUser();
  if (!user) redirect("/login");
  const { repository } = dataFor(user.id);
  await seedIfNeeded(repository);
  let library = await repository.library(params.chat);
  if (library.current && library.current.chat.demoKey && library.current.messages.length === 0) {
    await ensureDemoChat(repository, library.current.chat.id);
    library = await repository.library(library.current.chat.id);
  }
  const initialThread = params.thread && library.current?.threads.some((thread) => thread.id === params.thread)
    ? await getThreadData(params.thread, repository)
    : null;
  const missingChat = Boolean(params.chat) && library.current?.chat.id !== params.chat;
  return <ChatApp initialData={library} initialThread={initialThread} user={{ id: user.id, email: user.email }} providerStatus={getProviderStatus()} missingChat={missingChat} />;
}
