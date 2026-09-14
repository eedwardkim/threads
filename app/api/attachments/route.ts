import { apiError, assertLocalRequest, json, requiredId, withApiUser } from "@/lib/api";
import { MAX_ATTACHMENT_BYTES, safeAttachmentName, validateImage } from "@/lib/attachments/image";
import { AppError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Raw image upload: `POST /api/attachments?chat=<id>&name=<file name>` with the image as the body.
 * The format and dimensions are read from the bytes; the declared content type is never trusted.
 */
export async function POST(request: Request) {
  try {
    assertLocalRequest(request);
    const url = new URL(request.url);
    const chatId = requiredId(url.searchParams.get("chat"));
    const declared = Number(request.headers.get("content-length") ?? 0);
    if (declared > MAX_ATTACHMENT_BYTES) throw new AppError("Images must be under 6 MB.", 413, "too_large");
    const data = new Uint8Array(await request.arrayBuffer());
    let info;
    try {
      info = validateImage(data);
    } catch (error) {
      throw new AppError(error instanceof Error ? error.message : "That image could not be read.", error instanceof RangeError && /under/.test(error.message) ? 413 : 415, "invalid_image");
    }
    const { repository } = await withApiUser();
    const attachment = await repository.createAttachment({
      chatId, name: safeAttachmentName(url.searchParams.get("name") ?? "", info.mediaType), mediaType: info.mediaType, width: info.width, height: info.height, data,
    });
    return json({ attachment }, { status: 201 });
  } catch (error) { return apiError(error); }
}

export async function DELETE(request: Request) {
  try {
    assertLocalRequest(request);
    const id = requiredId(new URL(request.url).searchParams.get("id"));
    const { repository } = await withApiUser();
    return json({ deleted: await repository.deleteAttachment(id) });
  } catch (error) { return apiError(error); }
}
