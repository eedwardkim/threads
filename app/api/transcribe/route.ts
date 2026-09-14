import { apiError, assertLocalRequest, json, withApiUser } from "@/lib/api";
import { readDictation, transcribe, transcriptionProvider, TRANSCRIPTION_OPTIONS } from "@/lib/transcription";
import { AppError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  try {
    await withApiUser();
    return json({ provider: transcriptionProvider() });
  } catch (error) { return apiError(error); }
}

export async function POST(request: Request) {
  try {
    assertLocalRequest(request);
    await withApiUser();
    const header = request.headers.get("x-dictation-options") ?? "%7B%7D";
    if (header.length > 8000) throw new AppError("Dictation hints are too long.");
    let hints: unknown;
    try { hints = JSON.parse(decodeURIComponent(header)); } catch { throw new AppError("Dictation hints could not be read."); }
    const options = TRANSCRIPTION_OPTIONS.parse(hints);
    return json(await transcribe(await readDictation(request), options, request.signal));
  } catch (error) { return apiError(error); }
}
