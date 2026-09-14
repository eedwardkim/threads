import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

const PUBLIC_PATHS = ["/login", "/auth/"];

function isPublic(pathname: string): boolean {
  return PUBLIC_PATHS.some((prefix) => pathname === prefix || pathname.startsWith(prefix));
}

/**
 * Refreshes the Supabase session cookie on every request and sends signed-out visitors of
 * private pages to /login (the root goes to /welcome instead). API routes are never redirected: they return JSON 401 themselves so
 * fetch and streaming clients see a proper error instead of HTML.
 */
export async function proxy(request: NextRequest) {
  if (request.nextUrl.pathname === "/welcome") return NextResponse.next();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    if (request.nextUrl.pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Authentication is not configured.", code: "auth_unconfigured" }, { status: 503 });
    }
    return new NextResponse("Authentication is not configured. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY.", { status: 503 });
  }
  let response = NextResponse.next({ request });
  const supabase = createServerClient(url, key, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (list) => {
        for (const cookie of list) request.cookies.set(cookie.name, cookie.value);
        response = NextResponse.next({ request });
        for (const cookie of list) response.cookies.set(cookie.name, cookie.value, cookie.options);
      },
    },
  });
  // getClaims verifies the token and refreshes it when it is about to expire (writing new cookies).
  const { data } = await supabase.auth.getClaims();
  const pathname = request.nextUrl.pathname;
  if (!data?.claims?.sub && !isPublic(pathname) && !pathname.startsWith("/api/")) {
    const login = request.nextUrl.clone();
    login.pathname = pathname === "/" ? "/welcome" : "/login";
    login.search = "";
    const next = `${pathname}${request.nextUrl.search}`;
    if (next !== "/") login.searchParams.set("next", next);
    const redirect = NextResponse.redirect(login);
    for (const cookie of response.cookies.getAll()) redirect.cookies.set(cookie);
    return redirect;
  }
  if (data?.claims?.sub && data.claims.is_anonymous !== true && pathname === "/login") {
    const home = request.nextUrl.clone();
    home.pathname = "/";
    home.search = "";
    const redirect = NextResponse.redirect(home);
    for (const cookie of response.cookies.getAll()) redirect.cookies.set(cookie);
    return redirect;
  }
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff2?)$).*)"],
};
