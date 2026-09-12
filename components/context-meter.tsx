"use client";

import { ChevronDown, RefreshCw } from "lucide-react";
import { formatTokens } from "@/lib/tokens";
import type { ContextInfo } from "@/lib/types";

const labels = { goal: "Goal", constraints: "Constraints", decisions: "Decisions", artifacts: "Artifacts", open_questions: "Open questions" };

export function ContextMeter({ context, locked, onRefresh }: { context: ContextInfo; locked: boolean; onRefresh: () => void }) {
  const briefing = context.briefing?.kind === "compressed" ? context.briefing.briefing : null;
  const entries = briefing ? Object.entries(briefing) as [keyof typeof labels, string | string[]][] : [];
  return <div className="context-meter">
    <div className="context-meter-label"><span>Focused context</span><span data-testid="token-meter" title={context.actual ? "Prompt usage measured on the last response" : "Estimated at four characters per token"}>{formatTokens(context.tokens)} <span>/ {formatTokens(context.fullTokens)} tokens</span></span></div>
    <div className="context-bar" aria-hidden="true"><span style={{ width: `${Math.min(100, context.tokens / Math.max(1, context.fullTokens) * 100)}%` }} /></div>
    {context.fallback && <p className="context-fallback">Using the last four main-chat messages as context.</p>}
    {context.newMessages > 0 && <button className="update-context" disabled={locked} onClick={onRefresh}><RefreshCw size={12} /><span>Main chat has {context.newMessages} new {context.newMessages === 1 ? "message" : "messages"} — update context</span></button>}
    <details className="briefing-details"><summary><ChevronDown size={12} />What this thread knows</summary><div>
      <p className="briefing-note">{context.actual ? "Measured on the last response." : "Token counts are estimates."} The original answer and selected passage always stay intact.</p>
      {briefing ? entries.map(([key, value]) => <section key={key}><h4>{labels[key]}</h4>{typeof value === "string" ? <p>{value}</p> : <ul>{value.map((item, index) => <li key={`${key}:${index}`}>{item}</li>)}</ul>}</section>) : <p>A frozen snapshot of the last four main-chat messages surrounds the original answer.</p>}
    </div></details>
  </div>;
}
