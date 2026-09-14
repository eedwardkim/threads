import { z } from "zod";
import { apiError, assertLocalRequest, json, readBody, requiredId, withApiUser } from "@/lib/api";
import { AppError } from "@/lib/errors";
import { createThread, getThreadData, refreshThreadContext } from "@/lib/thread-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

function cancelled(request: Request, error: unknown): Response | null {
  if (request.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
    return json({ error: "Context preparation stopped.", code: "cancelled" }, { status: 499 });
  }
  return null;
}

export async function GET(request: Request) {
  try {
    const { repository } = await withApiUser();
    return json(await getThreadData(requiredId(new URL(request.url).searchParams.get("id")), repository));
  } catch (error) { return apiError(error); }
}

export async function POST(request: Request) {
  try {
    const input = await readBody(request, z.object({ parentMessageId: z.string().min(1).max(100), anchorStart: z.number().int().nonnegative(), anchorEnd: z.number().int().positive(), source: z.literal("user").default("user") }));
    const data = await withApiUser();
    return json({ thread: await createThread(input, { ...data, signal: request.signal }) }, { status: 201 });
  } catch (error) {
    return cancelled(request, error) ?? apiError(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const id = requiredId(new URL(request.url).searchParams.get("id"));
    const input = await readBody(request, z.union([z.object({ action: z.literal("refresh") }), z.object({ resolved: z.boolean() }), z.object({ title: z.string().min(1) })]));
    const data = await withApiUser();
    if ("action" in input) return json(await refreshThreadContext(id, { ...data, signal: request.signal }));
    await data.repository.updateThread(id, input);
    return json(await getThreadData(id, data.repository));
  } catch (error) {
    return cancelled(request, error) ?? apiError(error);
  }
}

export async function DELETE(request: Request) {
  try {
    assertLocalRequest(request);
    const id = requiredId(new URL(request.url).searchParams.get("id"));
    const { repository, jobs } = await withApiUser();
    const thread = await repository.getThread(id);
    if (!thread) throw new AppError("This thread no longer exists.", 404, "thread_not_found");
    await jobs.requestStopScope(thread.chatId, thread.id);
    await repository.deleteThread(id);
    return json({ ok: true });
  } catch (error) { return apiError(error); }
}
