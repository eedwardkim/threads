import { clearPrivateClientState } from "./client-state";
import { AppError } from "./errors";

let redirecting = false;

/** The session ended (expired or signed out elsewhere): drop private state and go to sign-in. */
function sessionEnded(): void {
  if (typeof window === "undefined" || redirecting) return;
  redirecting = true;
  clearPrivateClientState();
  const next = `${window.location.pathname}${window.location.search}`;
  window.location.assign(next && next !== "/" ? `/login?next=${encodeURIComponent(next)}` : "/login");
}

export async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    cache: "no-store",
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  let data: { error?: string; code?: string } & T;
  try {
    data = await response.json();
  } catch {
    if (response.status === 401) sessionEnded();
    throw new AppError("The request failed. Please try again.", response.status || 502, "request_failed");
  }
  if (!response.ok) {
    if (response.status === 401) sessionEnded();
    throw new AppError(data.error ?? "The request failed. Please try again.", response.status, data.code ?? "request_failed");
  }
  return data as T;
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong. Please try again.";
}
