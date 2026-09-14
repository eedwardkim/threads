import { z } from "zod";
import { apiError, assertLocalRequest, json, readBody, requiredId, withApiUser } from "@/lib/api";

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
    const { repository } = await withApiUser();
    return json({ folders: (await repository.library(null)).folders });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  try {
    const body = await readBody(request, createSchema);
    const { repository } = await withApiUser();
    const folder = await repository.createFolder(body.name, body.parentId ?? null);
    return json({ folder }, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const body = await readBody(request, patchSchema);
    const id = requiredId(new URL(request.url).searchParams.get("id"));
    const { repository } = await withApiUser();
    const folder = "name" in body ? await repository.renameFolder(id, body.name) : await repository.moveFolder(id, body.parentId);
    return json({ folder });
  } catch (error) {
    return apiError(error);
  }
}

export async function DELETE(request: Request) {
  try {
    assertLocalRequest(request);
    const id = requiredId(new URL(request.url).searchParams.get("id"));
    const { repository } = await withApiUser();
    await repository.deleteFolder(id);
    return json({ ok: true });
  } catch (error) {
    return apiError(error);
  }
}
