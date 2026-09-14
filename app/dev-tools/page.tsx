import { redirect } from "next/navigation";
import { DeveloperTools } from "@/components/developer-tools";
import { currentUser } from "@/lib/auth/server";
import { dataFor } from "@/lib/db/access";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function Page() {
  const user = await currentUser();
  if (!user) redirect("/login?next=%2Fdev-tools");
  const { repository } = dataFor(user.id);
  return <DeveloperTools enabled={await repository.demoEnabled()} />;
}
