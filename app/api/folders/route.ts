import { z } from "zod";
import { getRepository } from "@/lib/db/repository";
import { apiError, assertLocalRequest, readBody, requiredId } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const nameSchema = z.string().trim().min(1);
const parentIdSchema = z.string().min(1).max(100).nullable();
const createSchema = z.object({ name: nameSchema, parentId: parentIdSchema.optional() }).strict();
const patchSchema = z.union([
  z.object({ name: nameSchema }).strict(),
  z.object({ parentId: parentIdSchema }).strict(),
]);

export async function GET() {
  try {
    return Response.json({ folders: getRepository().listFolders() });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  try {
    const body = await readBody(request, createSchema);
    const folder = getRepository().createFolder(body.name, body.parentId ?? null);
    return Response.json({ folder }, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const body = await readBody(request, patchSchema);
    const id = requiredId(new URL(request.url).searchParams.get("id"));
    const repository = getRepository();
    const folder = "name" in body ? repository.renameFolder(id, body.name) : repository.moveFolder(id, body.parentId);
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
