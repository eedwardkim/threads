import { ShieldAlert, ShieldCheck } from "lucide-react";
import type { ProviderStatus } from "@/lib/types";

export function ProviderBanner({ status, errorCode }: { status: ProviderStatus; errorCode?: string }) {
  if (status.mock) return null;
  const anyProvider = status.deepseek || status.anthropic || status.openai;
  if (anyProvider && errorCode !== "invalid_key") return null;
  const rejected = anyProvider && errorCode === "invalid_key";
  return <div className="provider-banner" role="alert">
    {rejected ? <ShieldAlert size={18} /> : <ShieldCheck size={18} />}
    <p><strong>{rejected ? "Your API key was rejected." : "Add a provider key to continue."}</strong>
      {rejected ? "Check your API keys in " : "Set "}<code>DEEPSEEK_API_KEY</code>, <code>ANTHROPIC_API_KEY</code>, or <code>OPENAI_API_KEY</code> in <code>.env.local</code> and restart, or set <code>USE_MOCK=true</code> to use the local demo.
    </p>
  </div>;
}
