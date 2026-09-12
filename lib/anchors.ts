import type { Thread } from "./types";

export function validateAnchor(
  content: string,
  anchor: Pick<Thread, "anchorStart" | "anchorEnd" | "anchorExact">,
): boolean {
  const { anchorStart, anchorEnd, anchorExact } = anchor;
  const validRange = Number.isInteger(anchorStart)
    && Number.isInteger(anchorEnd)
    && anchorStart >= 0
    && anchorEnd > anchorStart
    && anchorEnd <= content.length;

  if (!validRange || content.slice(anchorStart, anchorEnd) !== anchorExact) {
    console.error("Anchor validation failed: the stored range or exact text does not match its parent message.");
    return false;
  }

  return true;
}
