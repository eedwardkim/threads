import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MessageList } from "../components/message-list";
import type { Message, Thread } from "../lib/types";

let host: HTMLDivElement;
let root: Root;
let notifyResize: () => void;
const message: Message = { id: "found-message", chatId: "focus-chat", threadId: null, role: "user", content: "The exact thought we searched for.", complete: true, modelKey: "fast", inputTokens: null, outputTokens: null, createdAt: 1 };
const threads: Thread[] = [];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { constructor(callback: () => void) { notifyResize = callback; } observe() {} disconnect() {} });
  vi.stubGlobal("CSS", { escape: (value: string) => value });
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  vi.unstubAllGlobals();
});

it("keeps search highlighting through database refreshes and Strict Mode remounts", async () => {
  const focus = { id: message.id, nonce: 1 };
  const render = (messages: Message[]) => <MessageList chatId="focus-chat" threadId={null} messages={messages} threads={threads} locked={false} focus={focus} />;
  await act(async () => root.render(render([message])));
  expect(host.querySelector("article")?.classList.contains("search-flash")).toBe(true);
  await act(async () => root.render(render([{ ...message }])));
  expect(host.querySelector("article")?.classList.contains("search-flash")).toBe(true);
  expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalledTimes(1);
  await act(async () => root.render(<StrictMode>{render([message])}</StrictMode>));
  expect(host.querySelector("article")?.classList.contains("search-flash")).toBe(true);
});

it("pauses even on a one-pixel upward scroll and resumes only at the bottom", async () => {
  await act(async () => root.render(<MessageList chatId="scroll-chat" threadId={null} messages={[{ ...message, chatId: "scroll-chat" }]} threads={threads} locked={false} />));
  const scroll = host.querySelector(".message-scroll") as HTMLElement;
  let height = 1000;
  let top = 0;
  Object.defineProperties(scroll, {
    scrollHeight: { get: () => height },
    clientHeight: { value: 500 },
    scrollTop: { get: () => top, set: (value: number) => { top = Math.max(0, Math.min(value, height - 500)); } },
  });
  scroll.scrollTop = 500;
  scroll.dispatchEvent(new Event("scroll"));
  scroll.dispatchEvent(new WheelEvent("wheel", { deltaY: -1, bubbles: true }));
  scroll.scrollTop = 499;
  scroll.dispatchEvent(new Event("scroll"));
  height = 1100;
  notifyResize();
  expect(scroll.scrollTop).toBe(499);
  scroll.scrollTop = 600;
  scroll.dispatchEvent(new Event("scroll"));
  height = 1200;
  notifyResize();
  expect(scroll.scrollTop).toBe(700);
});
