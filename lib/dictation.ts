export const MAX_DICTATION_BYTES = 3 * 1024 * 1024;
export const MAX_DICTATION_SECONDS = 180;
export const DICTATION_MIME_TYPES = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"] as const;

export function insertDictation(draft: string, text: string, start: number, end: number) {
  const before = draft.slice(0, start);
  const after = draft.slice(end);
  const insert = `${before && !/\s$/.test(before) ? " " : ""}${text.trim()}${after && !/^[\s.,!?;:)]/.test(after) ? " " : ""}`;
  return { text: before + insert + after, cursor: before.length + insert.length };
}
