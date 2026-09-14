import { AuthApiError, createClient, type User } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "../app/auth/guest/route";
import { registerGuest } from "../lib/auth/guest";
import { verifyUser } from "../lib/auth/server";

vi.mock("../lib/auth/guest", () => ({ registerGuest: vi.fn(), endGuest: vi.fn() }));
vi.mock("../lib/auth/server", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/auth/server")>(),
  createSupabaseServerClient: () => client,
}));

const client = createClient("http://127.0.0.1:54321", "test", { auth: { persistSession: false, autoRefreshToken: false } });
const user: User = {
  id: "fae71da8-c517-4bd3-b413-40481946d2c1", aud: "authenticated",
  app_metadata: {}, user_metadata: {}, created_at: "2026-09-14T10:00:00Z", is_anonymous: true,
};

function claims(anonymous = true): Awaited<ReturnType<typeof client.auth.getClaims>> {
  return {
    data: {
      claims: { sub: user.id, aud: "authenticated", exp: 2000000000, iat: 1900000000, iss: "supabase", is_anonymous: anonymous, role: "authenticated", aal: "aal1", session_id: user.id },
      header: { alg: "HS256", typ: "JWT", kid: "test" }, signature: new Uint8Array(),
    },
    error: null,
  };
}

describe("guest authentication boundary", () => {
  beforeEach(() => {
    vi.spyOn(client.auth, "getClaims").mockResolvedValue(claims());
    vi.spyOn(client.auth, "getUser").mockResolvedValue({ data: { user }, error: null });
    vi.spyOn(client.auth, "signOut").mockResolvedValue({ error: null });
    vi.mocked(registerGuest).mockResolvedValue(Date.now() + 60_000);
  });
  afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

  it("uses the live Auth creation timestamp, ignoring client enrollment metadata", async () => {
    const result = await POST(new Request("http://localhost/auth/guest", {
      method: "POST", body: JSON.stringify({ createdAt: "2099-01-01", userId: "another-user" }),
    }));
    expect(result.status).toBe(200);
    expect(registerGuest).toHaveBeenCalledExactlyOnceWith(user.id, user.created_at);
  });

  it("rejects a deleted anonymous account even while its JWT remains cryptographically valid", async () => {
    vi.mocked(client.auth.getUser).mockResolvedValue({ data: { user: null }, error: new AuthApiError("User not found", 404, "user_not_found") });
    expect(await verifyUser(client)).toBeNull();
    expect((await POST(new Request("http://localhost/auth/guest", { method: "POST" }))).status).toBe(401);
    expect(registerGuest).not.toHaveBeenCalled();
  });

  it("treats converted accounts as permanent even when their JWT has the old anonymous claim", async () => {
    vi.mocked(client.auth.getUser).mockResolvedValue({ data: { user: { ...user, is_anonymous: false } }, error: null });
    expect(await verifyUser(client)).toEqual({ id: user.id, email: null });
    expect((await POST(new Request("http://localhost/auth/guest", { method: "POST" }))).status).toBe(409);
    expect(registerGuest).not.toHaveBeenCalled();
  });

  it("does not enroll permanent identities or make them pay for another Auth lookup", async () => {
    vi.mocked(client.auth.getClaims).mockResolvedValue(claims(false));
    expect((await POST(new Request("http://localhost/auth/guest", { method: "POST" }))).status).toBe(409);
    expect(client.auth.getUser).not.toHaveBeenCalled();
    expect(registerGuest).not.toHaveBeenCalled();
  });

  it("clears an expired guest's cookies and rejects cross-origin enrollment", async () => {
    vi.mocked(registerGuest).mockResolvedValue(Date.now() - 1);
    expect((await POST(new Request("http://localhost/auth/guest", { method: "POST" }))).status).toBe(401);
    expect(client.auth.signOut).toHaveBeenCalledWith({ scope: "local" });
    vi.mocked(registerGuest).mockClear();
    expect((await POST(new Request("http://localhost/auth/guest", {
      method: "POST", headers: { Origin: "https://another.example" },
    }))).status).toBe(403);
    expect(registerGuest).not.toHaveBeenCalled();
  });
});
