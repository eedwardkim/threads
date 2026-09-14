import { z } from "zod";
import { apiError, json, readBody, withApiUser } from "@/lib/api";
import { seedDatabase } from "@/lib/seed";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({ action: z.literal("restore") }).strict();

export async function POST(request: Request) {
  try {
    await readBody(request, schema);
    const { repository } = await withApiUser();
    return json(await seedDatabase(repository));
  } catch (error) {
    return apiError(error);
  }
}
