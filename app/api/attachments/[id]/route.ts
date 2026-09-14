import { apiError, requiredId, withApiUser } from "@/lib/api";
import { AppError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Serves the owner's image bytes. Content is immutable, so the browser may cache it privately. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const id = requiredId((await params).id);
    const { repository } = await withApiUser();
    const attachment = await repository.getAttachment(id);
    if (!attachment) throw new AppError("Image not found.", 404, "attachment_not_found");
    return new Response(new Uint8Array(attachment.data), {
      headers: {
        "Content-Type": attachment.mediaType,
        "Content-Length": String(attachment.byteSize),
        "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(attachment.name)}`,
        "Cache-Control": "private, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) { return apiError(error); }
}
