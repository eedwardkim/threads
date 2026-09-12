import { getRepository } from "@/lib/db/repository";
import { apiError, assertLocalRequest, requiredId } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return Response.json({ folders: getRepository().listFolders() });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  try {
    assertLocalRequest(request);
    const body = await request.json();
    const folder = getRepository().createFolder(body.name, body.parentId ?? null);
    return Response.json({ folder }, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}

export async function PATCH(request: Request) {
  try {
    assertLocalRequest(request);
    const id = requiredId(new URL(request.url).searchParams.get("id"));
    const body = await request.json();
    const folder = getRepository().renameFolder(id, body.name);
    return Response.json({ folder });
  } catch (error) {
    return apiError(error);
  }
}

export async function DELETE(request: Request) {
  try {
    assertLocalRequest(request);
    getRepository().deleteFolder(requiredId(new URL(request.url).searchParams.get("id")));
    return Response.json({ ok: true });
  } catch (error) {
    return apiError(error);
  }
}
