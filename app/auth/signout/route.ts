import { NextResponse, type NextRequest } from "next/server";
import { assertLocalRequest } from "@/lib/api";
import { createSupabaseServerClient } from "@/lib/auth/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    assertLocalRequest(request);
  } catch {
    return NextResponse.json({ error: "This request must come from the app.", code: "invalid_origin" }, { status: 403 });
  }
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut({ scope: "local" });
  const wantsJson = request.headers.get("accept")?.includes("application/json");
  if (wantsJson) return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "private, no-store" } });
  const login = request.nextUrl.clone();
  login.pathname = "/login";
  login.search = "";
  return NextResponse.redirect(login, 303);
}
