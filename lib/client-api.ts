import { AppError } from "./errors";

export async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const data = await response.json();
  if (!response.ok) throw new AppError(data.error ?? "The request failed. Please try again.", response.status, data.code ?? "request_failed");
  return data as T;
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong. Please try again.";
}
