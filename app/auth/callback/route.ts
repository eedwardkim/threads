import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServerClient } from "@/lib/auth/server";
import { safeNextPath } from "@/lib/auth/redirect";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Completes email confirmation, magic-link, OAuth, and password-recovery flows (PKCE code exchange). */
export async function GET(request: NextRequest) {
  const url = request.nextUrl;
  const code = url.searchParams.get("code");
  const next = safeNextPath(url.searchParams.get("next"), url.searchParams.get("type") === "recovery" ? "/auth/reset" : "/");
  const destination = url.clone();
  destination.search = "";
  if (!code) {
    destination.pathname = "/login";
    destination.searchParams.set("error", url.searchParams.get("error_description") ?? "The sign-in link is invalid or has expired.");
    return NextResponse.redirect(destination, 303);
  }
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    destination.pathname = "/login";
    destination.searchParams.set("error", "The sign-in link is invalid or has expired.");
    return NextResponse.redirect(destination, 303);
  }
  const [pathname, search = ""] = next.split("?");
  destination.pathname = pathname;
  destination.search = search;
  const response = NextResponse.redirect(destination, 303);
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
