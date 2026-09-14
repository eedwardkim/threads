import { NextResponse, type NextRequest } from "next/server";
import { apiError, assertLocalRequest } from "@/lib/api";
import { createSupabaseServerClient, verifyUser } from "@/lib/auth/server";
import { endGuest } from "@/lib/auth/guest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    assertLocalRequest(request);
  } catch {
    return NextResponse.json({ error: "This request must come from the app.", code: "invalid_origin" }, { status: 403 });
  }
  const supabase = await createSupabaseServerClient();
  const user = await verifyUser(supabase);
  if (user?.isGuest) {
    try { await endGuest(user.id); }
    catch (error) { return apiError(error); }
  }
  await supabase.auth.signOut({ scope: "local" });
  const wantsJson = request.headers.get("accept")?.includes("application/json");
  if (wantsJson) return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "private, no-store" } });
  const login = request.nextUrl.clone();
  login.pathname = "/login";
  login.search = "";
  return NextResponse.redirect(login, 303);
}
