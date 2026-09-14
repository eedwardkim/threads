import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LandingPrompt } from "../components/landing-prompt";

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(<LandingPrompt />));
  await act(async () => Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Untangle an idea")?.click());
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

describe("new-tab guest entry", () => {
  it("keeps text out of the query string and detaches the opener", async () => {
    const tab = { opener: window, location: { replace: vi.fn() } };
    const open = vi.fn(() => tab);
    vi.stubGlobal("open", open);
    await act(async () => container.querySelector("textarea")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(open).toHaveBeenCalledWith("about:blank", "_blank");
    expect(tab.opener).toBeNull();
    const target = new URL(tab.location.replace.mock.calls[0][0], "https://example.test");
    expect(target.search).toBe("");
    expect(decodeURIComponent(target.hash.slice(1))).toContain("string theory");
  });

  it("keeps the draft and explains blocked popups", async () => {
    vi.stubGlobal("open", vi.fn(() => null));
    await act(async () => container.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("blocked");
    expect(container.querySelector("textarea")?.value).toContain("string theory");
  });

  it("does not submit while composing text or inserting a newline", async () => {
    const open = vi.fn();
    vi.stubGlobal("open", open);
    await act(async () => {
      container.querySelector("textarea")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }));
      container.querySelector("textarea")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true }));
    });
    expect(open).not.toHaveBeenCalled();
  });
});
