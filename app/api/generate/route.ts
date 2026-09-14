import { z } from "zod";
import { apiError, assertLocalRequest, readBody, withApiUser } from "../../../lib/api";
import { AppError } from "../../../lib/errors";
import { DuplicateRequest, prepareGeneration, STREAM_HEADERS, streamGeneration } from "../../../lib/generation";
import { MAX_ATTACHMENTS_PER_MESSAGE } from "../../../lib/attachments/image";
import { isModelKey, type ModelKey } from "../../../lib/models";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const id = z.string().min(1).max(100);
const schema = z.object({
  requestId: z.string().uuid(),
  chatId: id,
  threadId: id.nullable(),
  content: z.string().max(100_000).optional(),
  attachmentIds: z.array(id).max(MAX_ATTACHMENTS_PER_MESSAGE).optional(),
  modelKey: z.custom<ModelKey>(isModelKey),
  retryMessageId: id.optional(),
}).refine((input) => Boolean(input.retryMessageId || input.content?.trim() || input.attachmentIds?.length), { path: ["content"], message: "Enter a message or attach an image." })
  .refine((input) => !(input.retryMessageId && input.attachmentIds?.length), { path: ["attachmentIds"], message: "Retries cannot add attachments." });

export async function POST(request: Request): Promise<Response> {
  try {
    const input = await readBody(request, schema);
    const authStarted = performance.now();
    const data = await withApiUser();
    const authMs = performance.now() - authStarted;
    try {
      const prepared = await prepareGeneration(input, { ...data, signal: request.signal });
      const dbMs = performance.now() - authStarted - authMs;
      return new Response(streamGeneration(prepared, { ...data, signal: request.signal }), {
        headers: { ...STREAM_HEADERS, "Server-Timing": `auth;dur=${authMs.toFixed(1)}, db;dur=${dbMs.toFixed(1)}` },
      });
    } catch (error) {
      if (error instanceof DuplicateRequest) {
        return Response.json({ error: error.message, code: error.code, job: publicJob(error.job) }, { status: 409 });
      }
      throw error;
    }
  } catch (error) {
    return apiError(request.signal.aborted ? new AppError("Generation stopped.", 499, "aborted") : error);
  }
}

function publicJob(job: { id: string; status: string; chatId: string; threadId: string | null; messageId: string | null; userMessageId: string | null }) {
  return { id: job.id, status: job.status, chatId: job.chatId, threadId: job.threadId, messageId: job.messageId, userMessageId: job.userMessageId };
}

/** Lets a client reconcile a request whose response was lost. */
export async function GET(request: Request): Promise<Response> {
  try {
    const data = await withApiUser();
    const requestId = new URL(request.url).searchParams.get("id");
    if (requestId) {
      if (!z.string().uuid().safeParse(requestId).success) throw new AppError("Invalid request id.", 400, "invalid_id");
      const job = await data.jobs.get(requestId);
      if (!job) return Response.json({ job: null }, { status: 404 });
      return Response.json({ job: publicJob(job) });
    }
    const running = await data.jobs.listRunning();
    return Response.json({ jobs: running.filter((job) => job.kind === "generation").map(publicJob) });
  } catch (error) {
    return apiError(error);
  }
}

/** Durable stop: marks the caller's own job as cancelled so whichever instance runs it stops. */
export async function DELETE(request: Request): Promise<Response> {
  try {
    assertLocalRequest(request);
    const data = await withApiUser();
    const params = new URL(request.url).searchParams;
    const requestId = params.get("id");
    if (requestId) {
      if (!z.string().uuid().safeParse(requestId).success) throw new AppError("Invalid request id.", 400, "invalid_id");
      return Response.json({ ok: true, stopped: await data.jobs.requestStop(requestId) });
    }
    const chatId = params.get("chatId");
    if (!chatId || chatId.length > 100) throw new AppError("Choose a generation to stop.", 400, "invalid_id");
    const threadId = params.get("threadId");
    return Response.json({ ok: true, stopped: await data.jobs.requestStopScope(chatId, threadId ?? undefined) });
  } catch (error) {
    return apiError(error);
  }
}
