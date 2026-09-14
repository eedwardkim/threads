import { redirect } from "next/navigation";
import { PasswordResetForm } from "@/components/auth-form";
import { currentUser } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

export default async function ResetPasswordPage() {
  const user = await currentUser();
  if (!user) redirect("/login?mode=recover&error=Open%20the%20recovery%20link%20from%20your%20email%20first.");
  return <PasswordResetForm email={user.email} />;
}
