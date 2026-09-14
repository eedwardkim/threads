import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import type { Page } from "@playwright/test";

/**
 * Browser/API test helpers. Test users are disposable accounts created through the Supabase Auth admin API
 * (never by writing to the managed `auth` schema) in the local/approved test project named by .env.local.
 */
export function loadDotEnvLocal(): void {
  const file = resolve(process.cwd(), ".env.local");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2];
  }
}

loadDotEnvLocal();

export const BASE_URL = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3100";

function env(name: string, fallback?: string): string {
  const value = process.env[name]?.trim() || fallback;
  if (!value) throw new Error(`${name} is required for browser tests (see README: local Supabase).`);
  return value;
}

export interface TestUser {
  id: string;
  email: string;
  password: string;
}

export async function createTestUser(label = "e2e"): Promise<TestUser> {
  const admin = createClient(env("NEXT_PUBLIC_SUPABASE_URL"), env("SUPABASE_SECRET_KEY", process.env.SUPABASE_SERVICE_ROLE_KEY), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const email = `${label}-${randomUUID()}@example.com`;
  const password = `pw-${randomUUID()}`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw new Error(`Could not create test user: ${error?.message ?? "no user returned"}`);
  return { id: data.user.id, email, password };
}

export interface CookiePair {
  name: string;
  value: string;
}

/** Signs in without a browser and returns the exact cookies @supabase/ssr would write, for API/load clients. */
export async function sessionCookies(user: TestUser): Promise<CookiePair[]> {
  const jar = new Map<string, string>();
  const client = createServerClient(env("NEXT_PUBLIC_SUPABASE_URL"), env("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY), {
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (cookies) => {
        for (const cookie of cookies) {
          if (cookie.value) jar.set(cookie.name, cookie.value);
          else jar.delete(cookie.name);
        }
      },
    },
  });
  const { error } = await client.auth.signInWithPassword({ email: user.email, password: user.password });
  if (error) throw new Error(`Sign-in failed for test user: ${error.message}`);
  return [...jar].map(([name, value]) => ({ name, value }));
}

export function cookieHeader(cookies: CookiePair[]): string {
  return cookies.map((cookie) => `${cookie.name}=${encodeURIComponent(cookie.value)}`).join("; ");
}

/** Signs in through the real login form and waits for the workspace shell. */
export async function signInViaForm(page: Page, user: TestUser, next = "/"): Promise<void> {
  await page.goto(`/login?next=${encodeURIComponent(next)}`);
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.locator(".main-header").waitFor({ state: "visible" });
}

export interface StreamTiming {
  status: number;
  requestId: string;
  /** ms from request start until response headers arrived. */
  headersAt: number;
  /** ms until the `start` event (server admitted the job and persisted the user/assistant rows). */
  startAt: number | null;
  /** ms until the first `delta` carrying model text. */
  firstTextAt: number | null;
  lastTextAt: number | null;
  /** Longest pause between consecutive text deltas after the first one (stall detector). */
  maxGapMs: number;
  /** ms until the `finish` event, which is only emitted after the final save committed. */
  finishAt: number | null;
  /** Parsed Server-Timing durations (ms) reported by the route before streaming began. */
  serverTiming: Record<string, number>;
  events: number;
  text: string;
  messageId: string | null;
  finish: Record<string, unknown> | null;
  error: string | null;
}

export function parseServerTiming(header: string | null): Record<string, number> {
  const out: Record<string, number> = {};
  for (const part of header?.split(",") ?? []) {
    const match = /^\s*([\w-]+)\s*;\s*dur=([\d.]+)/.exec(part);
    if (match) out[match[1]] = Number(match[2]);
  }
  return out;
}

/** A minimal NDJSON client for /api/generate, used by API-level tests and the load harness. */
export async function streamGenerate(input: {
  baseUrl?: string;
  cookies: string;
  body: Record<string, unknown>;
  origin?: string;
  signal?: AbortSignal;
  onFirstText?: () => void;
}): Promise<StreamTiming> {
  const base = input.baseUrl ?? BASE_URL;
  const requestId = typeof input.body.requestId === "string" ? input.body.requestId : randomUUID();
  const started = performance.now();
  const response = await fetch(`${base}/api/generate`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: input.cookies, origin: input.origin ?? base },
    body: JSON.stringify({ ...input.body, requestId }),
    signal: input.signal,
  });
  const timing: StreamTiming = {
    status: response.status,
    requestId,
    headersAt: performance.now() - started,
    startAt: null,
    firstTextAt: null,
    lastTextAt: null,
    maxGapMs: 0,
    finishAt: null,
    serverTiming: parseServerTiming(response.headers.get("server-timing")),
    events: 0,
    text: "",
    messageId: null,
    finish: null,
    error: null,
  };
  if (!response.body) return timing;
  if (response.status !== 200) {
    timing.error = await response.text();
    return timing;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const handle = (line: string) => {
    if (!line.trim()) return;
    timing.events += 1;
    const event = JSON.parse(line) as Record<string, unknown>;
    if (event.type === "start") {
      timing.startAt = performance.now() - started;
      const message = event.message as { id?: string } | undefined;
      timing.messageId = message?.id ?? null;
    } else if (event.type === "delta" && typeof event.text === "string") {
      const now = performance.now() - started;
      if (timing.firstTextAt === null) {
        timing.firstTextAt = now;
        input.onFirstText?.();
      } else if (timing.lastTextAt !== null) {
        timing.maxGapMs = Math.max(timing.maxGapMs, now - timing.lastTextAt);
      }
      timing.lastTextAt = now;
      timing.text += event.text;
    } else if (event.type === "finish") {
      timing.finishAt = performance.now() - started;
      timing.finish = event;
    } else if (event.type === "error") {
      timing.error = typeof event.message === "string" ? event.message : JSON.stringify(event);
    }
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        handle(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf("\n");
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) handle(buffer);
  } catch (error) {
    if (!input.signal?.aborted) throw error;
  }
  return timing;
}

export async function api<T>(input: { baseUrl?: string; cookies: string; method?: string; path: string; body?: unknown }): Promise<{ status: number; json: T }> {
  const base = input.baseUrl ?? BASE_URL;
  const response = await fetch(`${base}${input.path}`, {
    method: input.method ?? "GET",
    headers: { "content-type": "application/json", cookie: input.cookies, origin: base },
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
  });
  const text = await response.text();
  return { status: response.status, json: (text ? JSON.parse(text) : null) as T };
}
