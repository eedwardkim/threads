import { and, eq, gt, lt, sql } from "drizzle-orm";
import { AppError } from "../errors";
import type { DatabaseHandle } from "./client";
import { generationJobs, rateWindows, usageLedger, type JobKind, type JobStatus } from "./schema";
import { withUser, type Tx } from "./session";

export type GenerationJob = typeof generationJobs.$inferSelect;

export interface GenerationLimits {
  requestsPerMinute: number;
  maxConcurrentPerUser: number;
  maxConcurrentTotal: number;
  dailyTokenLimit: number;
}

export interface AdmitInput {
  requestId: string;
  kind: JobKind;
  chatId: string;
  threadId: string | null;
  payloadHash: string;
  leaseMs: number;
  now?: number;
  limits?: Partial<GenerationLimits>;
}

export type AdmitResult = { admitted: true; job: GenerationJob } | { admitted: false; job: GenerationJob };

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a nonnegative integer.`);
  return value;
}

export function generationLimits(): GenerationLimits {
  return {
    requestsPerMinute: envInt("THREADS_RATE_LIMIT_PER_MINUTE", 30),
    maxConcurrentPerUser: envInt("THREADS_MAX_CONCURRENT_PER_USER", 4),
    maxConcurrentTotal: envInt("THREADS_MAX_CONCURRENT_TOTAL", 50),
    dailyTokenLimit: envInt("THREADS_DAILY_TOKEN_LIMIT", 0),
  };
}

export function scopeKey(chatId: string, threadId: string | null): string {
  return `${chatId}:${threadId ?? "main"}`;
}

function dayOf(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * Durable, owner-scoped coordination of generation work shared by every server instance.
 * Admission, cancellation, lease renewal, and terminal transitions are single short transactions;
 * the `fence` column protects the message row from stale workers.
 */
export class GenerationStore {
  constructor(private readonly handle: DatabaseHandle, readonly userId: string, private readonly guest = false) {}

  private run<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return withUser(this.handle, this.userId, fn, this.guest);
  }

  private owned() {
    return eq(generationJobs.ownerId, this.userId);
  }

  admit(input: AdmitInput): Promise<AdmitResult> {
    const limits = { ...generationLimits(), ...input.limits };
    const now = input.now ?? Date.now();
    const scope = scopeKey(input.chatId, input.threadId);
    return this.run(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`jobs:${this.userId}`}))`);
      const [existing] = await tx.select().from(generationJobs).where(and(eq(generationJobs.id, input.requestId), this.owned()));
      if (existing) {
        if (existing.payloadHash !== input.payloadHash) {
          throw new AppError("This request id was already used for a different message.", 409, "request_mismatch");
        }
        return { admitted: false, job: existing };
      }
      // Recover leases abandoned by crashed or timed-out workers so scopes never stay busy forever.
      await tx.update(generationJobs).set({ status: "expired", finishedAt: now, updatedAt: now, errorCode: "lease_expired" })
        .where(and(this.owned(), eq(generationJobs.status, "running"), lt(generationJobs.leaseExpiresAt, now)));
      const running = await tx.select({ scopeKey: generationJobs.scopeKey }).from(generationJobs)
        .where(and(this.owned(), eq(generationJobs.status, "running")));
      if (running.some((job) => job.scopeKey === scope)) {
        throw new AppError(input.threadId ? "This thread is still answering. Stop it or wait for it to finish." : "This conversation is still answering. Stop it or wait for it to finish.", 409, "generation_busy");
      }
      if (input.kind === "generation") {
        if (limits.maxConcurrentPerUser > 0 && running.length >= limits.maxConcurrentPerUser) {
          throw new AppError("Too many answers are streaming at once. Wait for one to finish.", 429, "too_many_generations");
        }
        if (limits.requestsPerMinute > 0) {
          const windowStart = Math.floor(now / 60_000) * 60_000;
          await tx.delete(rateWindows).where(and(eq(rateWindows.ownerId, this.userId), lt(rateWindows.windowStart, windowStart - 60_000)));
          const [window] = await tx.insert(rateWindows).values({ ownerId: this.userId, windowStart, requests: 1 })
            .onConflictDoUpdate({ target: [rateWindows.ownerId, rateWindows.windowStart], set: { requests: sql`${rateWindows.requests} + 1` } })
            .returning({ requests: rateWindows.requests });
          if (window.requests > limits.requestsPerMinute) {
            throw new AppError("You are sending messages too quickly. Please wait a moment.", 429, "rate_limited");
          }
        }
        if (limits.dailyTokenLimit > 0) {
          const [usage] = await tx.select({ input: usageLedger.inputTokens, output: usageLedger.outputTokens }).from(usageLedger)
            .where(and(eq(usageLedger.ownerId, this.userId), eq(usageLedger.day, dayOf(now))));
          if (usage && usage.input + usage.output >= limits.dailyTokenLimit) {
            throw new AppError("Today's usage limit has been reached. Try again tomorrow.", 429, "usage_limit");
          }
        }
        if (limits.maxConcurrentTotal > 0) {
          const [{ total }] = (await tx.execute(sql`select threads.count_running_jobs(${now}::bigint) as total`)) as unknown as { total: number }[];
          if (Number(total) >= limits.maxConcurrentTotal) {
            throw new AppError("Threads is busy right now. Please try again in a moment.", 503, "capacity");
          }
        }
      }
      const [job] = await tx.insert(generationJobs).values({
        id: input.requestId, ownerId: this.userId, kind: input.kind, chatId: input.chatId, threadId: input.threadId, scopeKey: scope,
        payloadHash: input.payloadHash, status: "running", leaseExpiresAt: now + input.leaseMs, createdAt: now, updatedAt: now,
      }).returning();
      return { admitted: true, job };
    });
  }

  attach(id: string, fence: number, fields: { messageId: string | null; userMessageId: string | null; attempt: number }): Promise<boolean> {
    return this.run(async (tx) => {
      const rows = await tx.update(generationJobs).set({ ...fields, updatedAt: Date.now() })
        .where(and(eq(generationJobs.id, id), this.owned(), eq(generationJobs.fence, fence), eq(generationJobs.status, "running"))).returning({ id: generationJobs.id });
      return rows.length > 0;
    });
  }

  /** Extends the lease; returns null when the lease was lost (expired, finished, or fenced out). */
  renew(id: string, fence: number, leaseMs: number, now = Date.now()): Promise<{ cancelRequested: boolean } | null> {
    return this.run(async (tx) => {
      const [row] = await tx.update(generationJobs).set({ leaseExpiresAt: now + leaseMs, updatedAt: now })
        .where(and(eq(generationJobs.id, id), this.owned(), eq(generationJobs.fence, fence), eq(generationJobs.status, "running"), gt(generationJobs.leaseExpiresAt, now)))
        .returning({ cancelRequested: generationJobs.cancelRequested });
      return row ?? null;
    });
  }

  finish(id: string, fence: number, status: Exclude<JobStatus, "running">, errorCode: string | null = null): Promise<boolean> {
    const now = Date.now();
    return this.run(async (tx) => {
      const rows = await tx.update(generationJobs).set({ status, errorCode, finishedAt: now, updatedAt: now })
        .where(and(eq(generationJobs.id, id), this.owned(), eq(generationJobs.fence, fence), eq(generationJobs.status, "running"))).returning({ id: generationJobs.id });
      return rows.length > 0;
    });
  }

  /** Durable stop for one of the caller's own jobs; returns false when there is nothing running. */
  requestStop(id: string): Promise<boolean> {
    return this.run(async (tx) => {
      const rows = await tx.update(generationJobs).set({ cancelRequested: true, updatedAt: Date.now() })
        .where(and(eq(generationJobs.id, id), this.owned(), eq(generationJobs.status, "running"))).returning({ id: generationJobs.id });
      return rows.length > 0;
    });
  }

  /** Stops running work in a chat (or a single thread) before conflicting deletion. */
  requestStopScope(chatId: string, threadId?: string): Promise<number> {
    return this.run(async (tx) => {
      const rows = await tx.update(generationJobs).set({ cancelRequested: true, updatedAt: Date.now() })
        .where(and(this.owned(), eq(generationJobs.status, "running"), eq(generationJobs.chatId, chatId),
          threadId === undefined ? undefined : eq(generationJobs.threadId, threadId))).returning({ id: generationJobs.id });
      return rows.length;
    });
  }

  async get(id: string): Promise<GenerationJob | null> {
    return this.run(async (tx) => (await tx.select().from(generationJobs).where(and(eq(generationJobs.id, id), this.owned())))[0] ?? null);
  }

  /** Jobs still running for this owner (after expiring stale leases). Used by clients to reconcile after a lost response. */
  listRunning(now = Date.now()): Promise<GenerationJob[]> {
    return this.run(async (tx) => {
      await tx.update(generationJobs).set({ status: "expired", finishedAt: now, updatedAt: now, errorCode: "lease_expired" })
        .where(and(this.owned(), eq(generationJobs.status, "running"), lt(generationJobs.leaseExpiresAt, now)));
      return tx.select().from(generationJobs).where(and(this.owned(), eq(generationJobs.status, "running")));
    });
  }

  recordUsage(inputTokens: number | null, outputTokens: number | null, now = Date.now()): Promise<void> {
    const input = inputTokens ?? 0;
    const output = outputTokens ?? 0;
    return this.run(async (tx) => {
      await tx.insert(usageLedger).values({ ownerId: this.userId, day: dayOf(now), inputTokens: input, outputTokens: output, requests: 1 })
        .onConflictDoUpdate({ target: [usageLedger.ownerId, usageLedger.day], set: {
          inputTokens: sql`${usageLedger.inputTokens} + ${input}`, outputTokens: sql`${usageLedger.outputTokens} + ${output}`, requests: sql`${usageLedger.requests} + 1`,
        } });
    });
  }
}
