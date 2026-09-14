import { z } from "zod";
import { apiError, assertLocalRequest, json, readBody, requiredId, withApiUser } from "@/lib/api";
import { AppError } from "@/lib/errors";
import { ensureDemoChat } from "@/lib/seed";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const folderIdSchema = z.string().min(1).max(100).nullable();
const createSchema = z.object({ folderId: folderIdSchema.optional() }).strict();
const patchSchema = z.union([
  z.object({ title: z.string().trim().min(1) }).strict(),
  z.object({ folderId: folderIdSchema }).strict(),
]);

export async function GET(request: Request) {
  try {
    const { repository } = await withApiUser();
    const id = new URL(request.url).searchParams.get("id");
    if (!id) {
      const { chats, folders } = await repository.library(null);
      return json({ chats, folders });
    }
    const chat = await repository.getChat(id);
    if (!chat) throw new AppError("This conversation no longer exists.", 404, "not_found");
    await ensureDemoChat(repository, id);
    const [messages, threads] = await Promise.all([repository.listMessages(id, null), repository.listThreads(id)]);
    return json({ chat, messages, threads });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  try {
    assertLocalRequest(request);
    const body = request.body ? await readBody(request, createSchema) : {};
    const { repository } = await withApiUser();
    return json({ chat: await repository.createChat(body.folderId ?? null) }, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const body = await readBody(request, patchSchema);
    const id = requiredId(new URL(request.url).searchParams.get("id"));
    const { repository } = await withApiUser();
    const chat = "title" in body ? await repository.renameChat(id, body.title) : await repository.moveChat(id, body.folderId);
    return json({ chat });
  } catch (error) {
    return apiError(error);
  }
}

export async function DELETE(request: Request) {
  try {
    assertLocalRequest(request);
    const id = requiredId(new URL(request.url).searchParams.get("id"));
    const { repository, jobs } = await withApiUser();
    // Stop any running work in this chat first; its rows disappear with the chat and fenced writers stop.
    await jobs.requestStopScope(id);
    await repository.deleteChat(id);
    return json({ ok: true });
  } catch (error) {
    return apiError(error);
  }
}
