/** Only same-origin absolute paths are accepted as post-auth destinations (no open redirects). */
export function safeNextPath(value: string | null | undefined, fallback = "/"): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return fallback;
  if (/[\u0000-\u001f\s]/.test(value) || value.includes("://")) return fallback;
  if (value.startsWith("/api/") || value.startsWith("/auth/") || value.startsWith("/login")) return fallback;
  return value;
}
