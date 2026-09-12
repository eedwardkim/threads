import type { PromptMessage } from "./types";

export function estimateTokens(value: string | PromptMessage[]): number {
  const text = typeof value === "string" ? value : value.map((message) => `${message.role}\n${message.content}`).join("\n\n");
  return Math.ceil(text.length / 4);
}

export function formatTokens(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(value);
}
