"use client";

import { useCallback, useSyncExternalStore } from "react";
import { isModelKey, type ModelKey } from "./models";

const listeners = new Set<() => void>();
const memory = new Map<string, string>();

function subscribe(listener: () => void) {
  const storageChanged = (event: StorageEvent) => {
    if (event.key) memory.delete(event.key);
    else memory.clear();
    listener();
  };
  listeners.add(listener);
  window.addEventListener("storage", storageChanged);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", storageChanged);
  };
}

function read(key: string): string | null {
  if (memory.has(key)) return memory.get(key)!;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function save(key: string, value: string) {
  memory.set(key, value);
  try {
    window.localStorage.setItem(key, value);
  } catch {}
  listeners.forEach((listener) => listener());
}

export function useModelPreference(scope: string, fallback: ModelKey) {
  const key = `threads:model:${scope}`;
  const snapshot = useCallback(() => {
    const value = read(key);
    return isModelKey(value) ? value : fallback;
  }, [key, fallback]);
  const model = useSyncExternalStore(subscribe, snapshot, () => fallback);
  return [model, (value: ModelKey) => save(key, value)] as const;
}

export function useThemePreference() {
  const theme = useSyncExternalStore<"dark" | "light">(subscribe, () => read("threads:theme") === "dark" ? "dark" : "light", () => "light");
  return [theme, () => save("threads:theme", theme === "dark" ? "light" : "dark")] as const;
}
