import { AppError } from "@/lib/errors";
import { apiError, json, requiredId, withApiUser } from "@/lib/api";
import { ensureDemoChat } from "@/lib/seed";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const chatId = requiredId(params.get("chatId"));
    const query = (params.get("q") ?? "").slice(0, 300);
    const { repository } = await withApiUser();
    if (!(await repository.getChat(chatId))) throw new AppError("This conversation no longer exists.", 404, "not_found");
    if (query.trim()) await ensureDemoChat(repository, chatId);
    return json({ results: await repository.searchMessages(chatId, query) });
  } catch (error) { return apiError(error); }
}
