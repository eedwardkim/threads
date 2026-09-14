import { z } from "zod";
import { apiError, json, readBody, withApiUser } from "@/lib/api";
import { seedDatabase } from "@/lib/seed";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({ action: z.enum(["restore", "hide", "show"]) }).strict();

export async function POST(request: Request) {
  try {
    const { action } = await readBody(request, schema);
    const { repository } = await withApiUser();
    if (action === "restore") {
      const result = await seedDatabase(repository);
      await repository.setDemoEnabled(true);
      return json(result);
    }
    await repository.setDemoEnabled(action === "show");
    return json({ enabled: action === "show" });
  } catch (error) {
    return apiError(error);
  }
}
