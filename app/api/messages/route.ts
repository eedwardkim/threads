import { z } from "zod";
import { apiError, json, readBody, withApiUser } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const input = await readBody(request, z.object({ action: z.literal("copy-to-main"), messageId: z.string().min(1).max(100) }));
    const { repository } = await withApiUser();
    return json({ message: await repository.copyMessageToMain(input.messageId) }, { status: 201 });
  } catch (error) { return apiError(error); }
}
