import { apiError, requiredId } from "@/lib/api";
import { getRepository } from "@/lib/db/repository";
import { ensureDemoChat } from "@/lib/seed";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const chatId = requiredId(params.get("chatId"));
    const query = (params.get("q") ?? "").slice(0, 300);
    const repository = getRepository();
    if (query.trim()) await ensureDemoChat(repository, chatId);
    return Response.json({ results: repository.searchMessages(chatId, query) });
  } catch (error) { return apiError(error); }
}
