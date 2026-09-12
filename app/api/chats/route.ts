import { getRepository } from "@/lib/db/repository";
import { apiError, assertLocalRequest, requiredId } from "@/lib/api";
import { AppError } from "@/lib/errors";
import { assertIdle } from "@/lib/generation-lock";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const repository = getRepository();
    const id = new URL(request.url).searchParams.get("id");
    if (!id) return Response.json({ chats: repository.listChats(), folders: repository.listFolders() });
    const chat = repository.getChat(id);
    if (!chat) throw new AppError("This conversation no longer exists.", 404, "not_found");
    return Response.json({ chat, messages: repository.listMessages(id), threads: repository.listThreads(id) });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  try {
    assertLocalRequest(request);
    return Response.json({ chat: getRepository().createChat() }, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}

export async function PATCH(request: Request) {
  try {
    assertLocalRequest(request);
    const id = requiredId(new URL(request.url).searchParams.get("id"));
    const body = await request.json();
    const repo = getRepository();
    const chat = body.title !== undefined
      ? repo.renameChat(id, body.title)
      : repo.moveChat(id, body.folderId ?? null);
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
