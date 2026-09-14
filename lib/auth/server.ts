import { createServerClient, type CookieOptions } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { AppError } from "../errors";

export interface AuthUser {
  id: string;
  email: string | null;
}

export interface SupabaseConfig {
  url: string;
  publishableKey: string;
}

export function supabaseConfig(): SupabaseConfig {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const publishableKey = (process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)?.trim();
  if (!url || !publishableKey) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY (or NEXT_PUBLIC_SUPABASE_ANON_KEY) are required.");
  }
  return { url, publishableKey };
}

export type CookieStore = {
  getAll(): { name: string; value: string }[];
  set(name: string, value: string, options?: CookieOptions): void;
};

/** Server client bound to a cookie store. Always one client per request; never shared. */
export function createSupabaseClient(store: CookieStore): SupabaseClient {
  const config = supabaseConfig();
  return createServerClient(config.url, config.publishableKey, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list) => {
        try {
          for (const cookie of list) store.set(cookie.name, cookie.value, cookie.options);
        } catch {
          // Server Components cannot write cookies; proxy.ts refreshes the session for them.
        }
      },
    },
  });
}

export async function createSupabaseServerClient(): Promise<SupabaseClient> {
  const store = await cookies();
  return createSupabaseClient(store);
}

/** Verifies the session token (signature + expiry) and returns the user, or null when unauthenticated. */
export async function verifyUser(client: SupabaseClient): Promise<AuthUser | null> {
  const { data, error } = await client.auth.getClaims();
  if (error || !data?.claims?.sub) return null;
  const email = typeof data.claims.email === "string" ? data.claims.email : null;
  return { id: data.claims.sub, email };
}

type Resolver = () => Promise<AuthUser | null>;
const authGlobal = globalThis as typeof globalThis & { __threadsAuthResolver?: Resolver };

export function setAuthResolverForTests(resolver: Resolver | undefined): void {
  authGlobal.__threadsAuthResolver = resolver;
}

export async function currentUser(): Promise<AuthUser | null> {
  if (authGlobal.__threadsAuthResolver) return authGlobal.__threadsAuthResolver();
  return verifyUser(await createSupabaseServerClient());
}

/** For API routes: JSON 401 instead of an HTML redirect. */
export async function requireUser(): Promise<AuthUser> {
  const user = await currentUser();
  if (!user) throw new AppError("Sign in to continue.", 401, "unauthorized");
  return user;
}
