import { AuthForm } from "@/components/auth-form";
import { safeNextPath } from "@/lib/auth/redirect";

export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; error?: string; mode?: string }> }) {
  const params = await searchParams;
  const mode = params.mode === "signup" || params.mode === "recover" ? params.mode : "signin";
  return (
    <AuthForm
      next={safeNextPath(params.next)}
      initialError={params.error?.slice(0, 200) ?? null}
      initialMode={mode}
      googleEnabled={process.env.NEXT_PUBLIC_AUTH_GOOGLE === "true"}
    />
  );
}
