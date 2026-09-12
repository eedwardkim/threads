import { z } from "zod";
import { apiError, readBody } from "@/lib/api";
import { getRepository } from "@/lib/db/repository";
import { assertIdle } from "@/lib/generation-lock";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const input = await readBody(request, z.object({ action: z.literal("copy-to-main"), messageId: z.string().min(1).max(100) }));
    assertIdle();
    return Response.json({ message: getRepository().copyMessageToMain(input.messageId) }, { status: 201 });
  } catch (error) { return apiError(error); }
}
