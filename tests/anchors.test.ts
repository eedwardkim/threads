import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateAnchor } from "../lib/anchors";

describe("validateAnchor", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("accepts exact, nonempty slices at either boundary", () => {
    const content = "A private answer";
    expect(validateAnchor(content, { anchorStart: 0, anchorEnd: 1, anchorExact: "A" })).toBe(true);
    expect(validateAnchor(content, { anchorStart: 2, anchorEnd: 16, anchorExact: "private answer" })).toBe(true);
    expect(validateAnchor(content, { anchorStart: 0, anchorEnd: content.length, anchorExact: content })).toBe(true);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("uses JavaScript string offsets without normalizing the selected text", () => {
    expect(validateAnchor("naïve café", { anchorStart: 6, anchorEnd: 10, anchorExact: "café" })).toBe(true);
    expect(validateAnchor("a\r\nb", { anchorStart: 1, anchorEnd: 3, anchorExact: "\r\n" })).toBe(true);
  });

  it.each([
    [-1, 2],
    [0, 5],
    [0, 0],
    [3, 2],
    [0.5, 2],
    [0, 2.5],
    [Number.NaN, 2],
    [0, Number.POSITIVE_INFINITY],
  ])("rejects invalid bounds %s to %s and logs the failure", (anchorStart, anchorEnd) => {
    expect(validateAnchor("text", { anchorStart, anchorEnd, anchorExact: "te" })).toBe(false);
    expect(console.error).toHaveBeenCalledOnce();
  });

  it("rejects an empty anchor in empty content", () => {
    expect(validateAnchor("", { anchorStart: 0, anchorEnd: 0, anchorExact: "" })).toBe(false);
  });

  it("logs exact-text mismatches without logging private text", () => {
    const content = "Confidential parent message";
    const anchorExact = "Sensitive stale selection";
    expect(validateAnchor(content, { anchorStart: 0, anchorEnd: 12, anchorExact })).toBe(false);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("Anchor validation failed"));
    const logged = JSON.stringify(vi.mocked(console.error).mock.calls);
    expect(logged).not.toContain(content);
    expect(logged).not.toContain(anchorExact);
    expect(logged).not.toContain(content.slice(0, 12));
  });
});
