import { z } from "zod";
import { apiError, assertLocalRequest, readBody, requiredId } from "@/lib/api";
import { getRepository } from "@/lib/db/repository";
import { assertIdle } from "@/lib/generation-lock";
import { createThread, getThreadData, refreshThreadContext } from "@/lib/thread-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    return Response.json(getThreadData(requiredId(new URL(request.url).searchParams.get("id"))));
  } catch (error) { return apiError(error); }
}

export async function POST(request: Request) {
  try {
    const input = await readBody(request, z.object({ parentMessageId: z.string().min(1).max(100), anchorStart: z.number().int().nonnegative(), anchorEnd: z.number().int().positive(), source: z.literal("user").default("user") }));
    return Response.json({ thread: await createThread(input, { signal: request.signal }) }, { status: 201 });
  } catch (error) {
    if (request.signal.aborted || (error instanceof Error && error.name === "AbortError")) return Response.json({ error: "Context preparation stopped.", code: "cancelled" }, { status: 499 });
    return apiError(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const id = requiredId(new URL(request.url).searchParams.get("id"));
    const input = await readBody(request, z.union([z.object({ action: z.literal("refresh") }), z.object({ resolved: z.boolean() })]));
    if ("action" in input) return Response.json(await refreshThreadContext(id, { signal: request.signal }));
    assertIdle();
    getRepository().updateThread(id, input);
    return Response.json(getThreadData(id));
  } catch (error) {
    if (request.signal.aborted || (error instanceof Error && error.name === "AbortError")) return Response.json({ error: "Context preparation stopped.", code: "cancelled" }, { status: 499 });
    return apiError(error);
  }
}

export async function DELETE(request: Request) {
  try {
    assertLocalRequest(request);
    assertIdle();
    getRepository().deleteThread(requiredId(new URL(request.url).searchParams.get("id")));
    return Response.json({ ok: true });
  } catch (error) { return apiError(error); }
}
