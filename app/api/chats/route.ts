import { z } from "zod";
import { getRepository } from "@/lib/db/repository";
import { apiError, assertLocalRequest, readBody, requiredId } from "@/lib/api";
import { AppError } from "@/lib/errors";
import { assertIdle } from "@/lib/generation-lock";
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
    const repository = getRepository();
    const id = new URL(request.url).searchParams.get("id");
    if (!id) return Response.json({ chats: repository.listChats(), folders: repository.listFolders() });
    const chat = repository.getChat(id);
    if (!chat) throw new AppError("This conversation no longer exists.", 404, "not_found");
    await ensureDemoChat(repository, id);
    return Response.json({ chat, messages: repository.listMessages(id), threads: repository.listThreads(id) });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  try {
    assertLocalRequest(request);
    const body = request.body ? await readBody(request, createSchema) : {};
    return Response.json({ chat: getRepository().createChat(body.folderId ?? null) }, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const body = await readBody(request, patchSchema);
    const id = requiredId(new URL(request.url).searchParams.get("id"));
    const repo = getRepository();
    const chat = "title" in body ? repo.renameChat(id, body.title) : repo.moveChat(id, body.folderId);
    return Response.json({ chat });
  } catch (error) {
    return apiError(error);
  }
}

export async function DELETE(request: Request) {
  try {
    assertLocalRequest(request);
    assertIdle();
    getRepository().deleteChat(requiredId(new URL(request.url).searchParams.get("id")));
    return Response.json({ ok: true });
  } catch (error) {
    return apiError(error);
  }
}
