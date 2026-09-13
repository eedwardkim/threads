import { z } from "zod";
import { apiError, readBody } from "@/lib/api";
import { getRepository } from "@/lib/db/repository";
import { assertIdle } from "@/lib/generation-lock";
import { seedDatabase } from "@/lib/seed";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({ action: z.literal("restore") }).strict();

export async function POST(request: Request) {
  try {
    await readBody(request, schema);
    assertIdle();
    return Response.json(seedDatabase(getRepository()));
  } catch (error) {
    return apiError(error);
  }
}
