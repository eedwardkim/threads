import { z } from "zod";
import type { Briefing, FrozenContext } from "./types";

export const briefingSchema = z.object({
  goal: z.string(),
  constraints: z.array(z.string()),
  decisions: z.array(z.string()),
  artifacts: z.array(z.string()),
  open_questions: z.array(z.string()),
});

const frozenContextSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("compressed"), briefing: briefingSchema }),
  z.object({
    kind: z.literal("fallback"),
    messages: z.array(z.object({ role: z.enum(["system", "user", "assistant"]), content: z.string() })),
  }),
]);
const usageCutoffSchema = z.object({ usageInvalidatedThrough: z.number().int().nonnegative() });
const measuredMessageSchema = z.object({ measuredMessageId: z.string().min(1).max(100) });
const contextObjectSchema = z.record(z.string(), z.unknown());

function decodeJSON(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function parseBriefing(value: unknown): Briefing | null {
  const result = briefingSchema.safeParse(decodeJSON(value));
  return result.success ? result.data : null;
}

export function parseFrozenContext(value: string | null): FrozenContext | null {
  const result = frozenContextSchema.safeParse(decodeJSON(value));
  return result.success ? result.data : null;
}

export function getContextUsageCutoff(value: string | null): number | null {
  const result = usageCutoffSchema.safeParse(decodeJSON(value));
  return result.success ? result.data.usageInvalidatedThrough : null;
}

export function getContextMeasuredMessageId(value: string | null): string | null {
  const result = measuredMessageSchema.safeParse(decodeJSON(value));
  return result.success ? result.data.measuredMessageId : null;
}

export function attributeContextUsage(current: string | null, snapshot: string | null, messageId: string): string | null {
  const currentContext = contextObjectSchema.safeParse(decodeJSON(current ?? "{}"));
  const snapshotContext = contextObjectSchema.safeParse(decodeJSON(snapshot ?? "{}"));
  if (!currentContext.success || !snapshotContext.success) return null;
  delete currentContext.data.measuredMessageId;
  delete snapshotContext.data.measuredMessageId;
  if (JSON.stringify(currentContext.data) !== JSON.stringify(snapshotContext.data)) return null;
  return JSON.stringify({ ...currentContext.data, measuredMessageId: messageId });
}
