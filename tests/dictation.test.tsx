import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Dictation } from "../components/dictation";
import { clearPrivateClientState } from "../lib/client-state";

class FakeRecorder {
  static instances: FakeRecorder[] = [];
  static isTypeSupported() { return true; }
  state = "inactive";
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() { FakeRecorder.instances.push(this); }
  start() { this.state = "recording"; }
  stop() {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["audio"]) });
    this.onstop?.();
  }
}
let root: Root;
let container: HTMLDivElement;
const stopTrack = vi.fn();
const insert = vi.fn(() => true);
const busy = vi.fn();
let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("MediaRecorder", FakeRecorder);
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop: stopTrack }] }) } });
  fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => Response.json(init?.method === "POST" ? { text: "The eigenvector." } : { provider: "openai" }));
  vi.stubGlobal("fetch", fetcher);
  container = document.createElement("div");
  root = createRoot(container);
  await act(() => root.render(createElement(Dictation, { disabled: false, context: "Existing draft", onInsert: insert, onBusy: busy })));
});
afterEach(async () => { await act(() => root.unmount()); vi.clearAllMocks(); vi.unstubAllGlobals(); });

function click(label: string) {
  const button = [...container.querySelectorAll("button")].find((item) => item.getAttribute("aria-label") === label || item.textContent === label);
  expect(button).toBeDefined();
  return act(async () => button!.click());
}

it("stops the microphone, reviews and inserts only after explicit approval", async () => {
  await click("Dictate message");
  expect(FakeRecorder.instances.at(-1)?.state).toBe("recording");
  await click("Stop and transcribe");
  expect(stopTrack).toHaveBeenCalledOnce();
  expect(container.querySelector("textarea")?.value).toBe("The eigenvector.");
  expect(insert).not.toHaveBeenCalled();
  expect(fetcher.mock.calls[1][0]).toBe("/api/transcribe");
  await click("Insert transcript");
  expect(insert).toHaveBeenCalledWith("The eigenvector.");
  expect(container.querySelector("section")).toBeNull();
});

it("retains failed audio for retry and discards private state on sign-out", async () => {
  fetcher.mockImplementation(async (_url, init) => init?.method === "POST" ? Response.json({ error: "Busy" }, { status: 429 }) : Response.json({ provider: "openai" }));
  await click("Dictate message");
  await click("Stop and transcribe");
  expect(container.textContent).toContain("Busy");
  fetcher.mockResolvedValue(Response.json({ text: "Retried." }));
  await click("Retry recording");
  expect(container.querySelector("textarea")?.value).toBe("Retried.");
  await act(() => clearPrivateClientState());
  expect(container.querySelector("section")).toBeNull();
  expect(insert).not.toHaveBeenCalled();
});

it("cancels capture without uploading", async () => {
  await click("Dictate message");
  await click("Cancel dictation");
  expect(stopTrack).toHaveBeenCalledOnce();
  expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
});

it("ignores delayed microphone permission after cancellation", async () => {
  let grant!: (stream: { getTracks: () => { stop: () => void }[] }) => void;
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: () => new Promise((resolve) => { grant = resolve; }) } });
  await click("Dictate message");
  await click("Cancel dictation");
  await act(async () => grant({ getTracks: () => [{ stop: stopTrack }] }));
  expect(stopTrack).toHaveBeenCalledOnce();
  expect(container.querySelector("section")).toBeNull();
});
