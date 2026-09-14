"use client";

import { registerPrivateState } from "./client-state";
import type { ChatData, ThreadData } from "./types";

const MAX_CHATS = 24;
const MAX_THREADS = 48;

/** Bounded LRU of views the user already saw; keyed per account and wiped on sign-out. */
class Lru<T> {
  private readonly items = new Map<string, T>();
  constructor(private readonly limit: number) {}

  get(key: string): T | undefined {
    const value = this.items.get(key);
    if (value !== undefined) {
      this.items.delete(key);
      this.items.set(key, value);
    }
    return value;
  }

  set(key: string, value: T): void {
    this.items.delete(key);
    this.items.set(key, value);
    while (this.items.size > this.limit) {
      const oldest = this.items.keys().next().value;
      if (oldest === undefined) break;
      this.items.delete(oldest);
    }
  }

  delete(key: string): void {
    this.items.delete(key);
  }

  clear(): void {
    this.items.clear();
  }
}

const chatViews = new Lru<ChatData>(MAX_CHATS);
const threadViews = new Lru<ThreadData>(MAX_THREADS);

registerPrivateState(() => {
  chatViews.clear();
  threadViews.clear();
});

export const chatCache = {
  getChat: (chatId: string) => chatViews.get(chatId),
  setChat: (data: ChatData) => chatViews.set(data.chat.id, data),
  dropChat(chatId: string) {
    chatViews.delete(chatId);
  },
  getThread: (threadId: string) => threadViews.get(threadId),
  setThread: (data: ThreadData) => threadViews.set(data.thread.id, data),
  dropThread(threadId: string) {
    threadViews.delete(threadId);
  },
};
