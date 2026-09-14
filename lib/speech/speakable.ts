import type { Blockquote, Code, Heading, List, ListItem, Node, Paragraph, Parent, PhrasingContent, Root, RootContent, Table } from "mdast";
import type { InlineMath, Math as MathNode } from "mdast-util-math";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { spokenMath } from "./math";

/**
 * Turns a persisted Markdown message into speech-ready text. Runs identically on the server (to
 * synthesize a chunk) and in the browser (to know how many chunks exist and which source range each
 * covers for highlighting), so it must be pure and deterministic. Bump `SPEECH_PIPELINE_VERSION`
 * whenever the output changes: it is part of the audio URL and invalidates cached audio.
 */
export const SPEECH_PIPELINE_VERSION = 1;

/** Provider input limits are ~4k characters; smaller chunks start faster and let the player skip precisely. */
export const FIRST_CHUNK_LIMIT = 420;
export const CHUNK_LIMIT = 1_000;
export const HARD_CHUNK_LIMIT = 2_400;

export interface SpeechSegment {
  text: string;
  /** Source offsets of the block this text was derived from (for highlighting). */
  start: number;
  end: number;
  heading: boolean;
}

export interface SpeechChunk {
  index: number;
  text: string;
  start: number;
  end: number;
}

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);

function offsets(node: Node): { start: number; end: number } {
  return { start: node.position?.start.offset ?? 0, end: node.position?.end.offset ?? 0 };
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").replace(/\s+([,.;:!?])/g, "$1").trim();
}

/** Adds a terminal period so the voice pauses between blocks instead of running them together. */
function sentence(text: string): string {
  const trimmed = collapse(text);
  if (!trimmed) return "";
  return /[.!?:;,…]["')\]]?$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function inlineCode(value: string): string {
  const compact = collapse(value);
  // Short identifiers read naturally; longer snippets are announced so the listener knows it is code.
  return compact.length <= 40 ? compact : `the code ${compact}`;
}

function phrasing(nodes: readonly (PhrasingContent | RootContent)[]): string {
  return nodes.map((node): string => {
    switch (node.type) {
      case "text": return node.value;
      case "inlineCode": return ` ${inlineCode(node.value)} `;
      case "inlineMath": return ` ${spokenMath((node as InlineMath).value)} `;
      case "image": return node.alt ? ` Image: ${node.alt}. ` : " An image. ";
      case "imageReference": return node.alt ? ` Image: ${node.alt}. ` : " An image. ";
      case "break": return " ";
      case "html": return "";
      case "footnoteReference": return "";
      case "emphasis": case "strong": case "delete": case "link": case "linkReference":
        return phrasing((node as Parent).children as PhrasingContent[]);
      default:
        return "children" in node ? phrasing((node as Parent).children as PhrasingContent[]) : "";
    }
  }).join("");
}

function codeBlock(node: Code): string {
  const lines = node.value.split("\n").length;
  const language = node.lang?.trim();
  return `${language ? `A ${language} code block` : "A code block"} with ${lines} ${lines === 1 ? "line" : "lines"}.`;
}

function table(node: Table): string {
  const [header, ...rows] = node.children;
  const headers = header?.children.map((cell) => collapse(phrasing(cell.children))) ?? [];
  const body = rows.map((row) => sentence(row.children.map((cell, index) => {
    const value = collapse(phrasing(cell.children));
    return headers[index] && value ? `${headers[index]}: ${value}` : value;
  }).filter(Boolean).join(", ")));
  return [sentence(`A table with columns ${headers.join(", ")}`), ...body].join(" ");
}

/** Content of a list item, blockquote, etc. flattened into one utterance. */
function blockText(nodes: readonly RootContent[], ordinal: (index: number) => string = () => ""): string {
  return collapse(nodes.map((node, index) => {
    switch (node.type) {
      case "paragraph": return sentence(phrasing((node as Paragraph).children));
      case "heading": return sentence(phrasing((node as Heading).children));
      case "code": return codeBlock(node as Code);
      case "math": return sentence(spokenMath((node as MathNode).value));
      case "blockquote": return sentence(`Quote: ${blockText((node as Blockquote).children)}`);
      case "list": return listItems(node as List).join(" ");
      case "table": return table(node as Table);
      case "listItem": return sentence(`${ordinal(index)}${blockText((node as ListItem).children)}`);
      case "thematicBreak": case "html": case "definition": case "footnoteDefinition": case "yaml": return "";
      default: return sentence(phrasing([node]));
    }
  }).filter(Boolean).join(" "));
}

function listItems(list: List): string[] {
  const start = list.start ?? 1;
  return list.children.map((item, index) => {
    const prefix = list.ordered ? `${start + index}. ` : "";
    const checkbox = item.checked === true ? "Done: " : item.checked === false ? "To do: " : "";
    return sentence(`${prefix}${checkbox}${blockText(item.children)}`);
  }).filter(Boolean);
}

export function speechSegments(source: string): SpeechSegment[] {
  const tree = parser.parse(source) as Root;
  const segments: SpeechSegment[] = [];
  const push = (node: Node, text: string, heading = false) => {
    const clean = collapse(text);
    if (clean) segments.push({ text: clean, ...offsets(node), heading });
  };
  for (const node of tree.children) {
    switch (node.type) {
      case "heading": push(node, sentence(phrasing(node.children)), true); break;
      case "paragraph": push(node, sentence(phrasing(node.children))); break;
      case "code": push(node, codeBlock(node)); break;
      case "math": push(node, sentence(spokenMath(node.value))); break;
      case "blockquote": push(node, sentence(`Quote: ${blockText(node.children)}`)); break;
      case "table": push(node, table(node)); break;
      case "list": {
        const items = listItems(node);
        node.children.forEach((item, index) => { if (items[index]) push(item, items[index]); });
        break;
      }
      case "thematicBreak": case "html": case "definition": case "footnoteDefinition": case "yaml": break;
      default: push(node, sentence(phrasing([node])));
    }
  }
  return segments;
}

function splitLong(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const pieces: string[] = [];
  let current = "";
  for (const part of text.split(/(?<=[.!?;])\s+/)) {
    if (current && current.length + part.length + 1 > limit) { pieces.push(current); current = part; }
    else current = current ? `${current} ${part}` : part;
    while (current.length > limit) { pieces.push(current.slice(0, limit)); current = current.slice(limit); }
  }
  if (current) pieces.push(current);
  return pieces;
}

/** Groups segments into synthesis requests: a small first chunk for fast start, then ~1k characters each. */
export function speechChunks(source: string): SpeechChunk[] {
  const chunks: SpeechChunk[] = [];
  let buffer: SpeechSegment[] = [];
  const flush = () => {
    if (!buffer.length) return;
    const text = buffer.map((segment) => segment.text).join(" ");
    const start = buffer[0].start;
    const end = buffer[buffer.length - 1].end;
    for (const piece of splitLong(text, HARD_CHUNK_LIMIT)) chunks.push({ index: chunks.length, text: piece, start, end });
    buffer = [];
  };
  for (const segment of speechSegments(source)) {
    const limit = chunks.length === 0 ? FIRST_CHUNK_LIMIT : CHUNK_LIMIT;
    const size = buffer.reduce((total, item) => total + item.text.length + 1, 0);
    if (buffer.length && (segment.heading || size + segment.text.length > limit)) flush();
    buffer.push(segment);
    if (chunks.length === 0 && !segment.heading) flush();
  }
  flush();
  return chunks;
}

/** The whole message as one speech-ready string (for previews, tests, and clipboard). */
export function speechText(source: string): string {
  return speechSegments(source).map((segment) => segment.text).join("\n\n");
}
