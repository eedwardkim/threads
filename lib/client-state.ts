"use client";

const resetters = new Set<() => void>();
let boundUserId: string | null = null;

/** Registers private in-memory state that must be discarded on sign-out or account change. */
export function registerPrivateState(reset: () => void): () => void {
  resetters.add(reset);
  return () => resetters.delete(reset);
}

export function clearPrivateClientState(): void {
  for (const reset of resetters) reset();
  boundUserId = null;
}

/** Binds client state to the verified user id rendered by the server; switching accounts wipes it. */
export function bindClientUser(userId: string): void {
  if (boundUserId !== null && boundUserId !== userId) clearPrivateClientState();
  boundUserId = userId;
}

export function currentClientUser(): string | null {
  return boundUserId;
}
