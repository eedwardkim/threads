import { ZodError, type ZodType } from "zod";
import { AppError } from "./errors";

function isLoopbackPreview(origin: string, expected: string, site: string | null): boolean {
  if (site !== "same-origin" || !URL.canParse(origin) || !URL.canParse(expected)) return false;
  const source = new URL(origin);
  const target = new URL(expected);
  return source.origin === origin && source.protocol === target.protocol && source.hostname === target.hostname
    && ["localhost", "127.0.0.1", "[::1]"].includes(target.hostname);
}

export function assertLocalRequest(request: Request) {
  const origin = request.headers.get("origin");
  const url = new URL(request.url);
  const expectedOrigin = `${url.protocol}//${request.headers.get("host") ?? url.host}`;
  const site = request.headers.get("sec-fetch-site");
  if (site === "cross-site" || (origin && origin !== expectedOrigin && !isLoopbackPreview(origin, expectedOrigin, site))) {
    throw new AppError("This request must come from the app.", 403, "invalid_origin");
  }
}

export async function readBody<T>(request: Request, schema: ZodType<T>): Promise<T> {
  assertLocalRequest(request);
  const text = await request.text();
  if (text.length > 120_000) throw new AppError("This message is too long. Try a shorter passage.", 413, "too_large");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new AppError("The request could not be read. Please try again.", 400, "invalid_json");
  }
  return schema.parse(body);
}

export function apiError(error: unknown): Response {
  if (error instanceof ZodError) return Response.json({ error: "Check the request and try again.", code: "invalid_request" }, { status: 400 });
  if (error instanceof AppError) return Response.json({ error: error.message, code: error.code }, { status: error.status });
  console.error("[api] Unexpected request failure", error instanceof Error ? error.name : "Unknown error");
  return Response.json({ error: "Something went wrong. Your saved conversations are safe. Please try again.", code: "server_error" }, { status: 500 });
}

export function requiredId(value: string | null): string {
  if (!value || value.length > 100) throw new AppError("Choose a conversation first.", 400, "invalid_id");
  return value;
}
