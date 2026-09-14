import { apiError, assertLocalRequest, json } from "@/lib/api";
import { createSupabaseServerClient, verifyUser } from "@/lib/auth/server";
import { registerGuest } from "@/lib/auth/guest";
import { AppError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    assertLocalRequest(request);
    const supabase = await createSupabaseServerClient();
    const user = await verifyUser(supabase);
    if (!user) throw new AppError("Start a guest session first.", 401, "unauthorized");
    if (!user.isGuest) throw new AppError("You are already signed in.", 409, "already_signed_in");
    const expiresAt = user.guestCreatedAt ? await registerGuest(user.id, user.guestCreatedAt) : null;
    if (!expiresAt || expiresAt <= Date.now()) {
      await supabase.auth.signOut({ scope: "local" });
      throw new AppError("That guest session has expired. Continue as guest again to start fresh.", 401, "guest_expired");
    }
    return json({ expiresAt });
  } catch (error) { return apiError(error); }
}
