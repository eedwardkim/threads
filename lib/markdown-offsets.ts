import type { Element, Properties, Root, Text as HastText } from "hast";
import { createHighlighterCoreSync } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import typescript from "shiki/langs/typescript.mjs";
import json from "shiki/langs/json.mjs";
import sql from "shiki/langs/sql.mjs";
import githubDark from "shiki/themes/github-dark.mjs";
import githubLight from "shiki/themes/github-light.mjs";
import { validateAnchor } from "./anchors";
import type { Thread } from "./types";

type Container = Root | Element;
type Bounds = { start: number; end: number };
type MappedLeaf = Bounds & { element: Element; parent: Container };
type TokenPart = Bounds & { style?: string };

let highlighter: ReturnType<typeof createHighlighterCoreSync> | undefined;

function getHighlighter() {
  highlighter ??= createHighlighterCoreSync({
    engine: createJavaScriptRegexEngine(),
    langs: [typescript, json, sql],
    themes: [githubDark, githubLight],
  });
  return highlighter;
}

function whitespace(value: string): boolean {
  return /^[\t\r\n ]*$/.test(value);
}

function positionBounds(node: Element | HastText, source: string): Bounds | null {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (typeof start !== "number" || typeof end !== "number"
    || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)
    || start < 0 || end < start || end > source.length) return null;
  return { start, end };
}

function inlineCodeBounds(node: Element, value: string, source: string): Bounds | null {
  const bounds = positionBounds(node, source);
  if (!bounds) return null;
  const raw = source.slice(bounds.start, bounds.end);
  const opening = /^`+/.exec(raw)?.[0];
  const closing = /`+$/.exec(raw)?.[0];
  if (!opening || closing !== opening || raw.length < opening.length * 2) return null;
  let start = bounds.start + opening.length;
  let end = bounds.end - opening.length;
  const inner = source.slice(start, end);
  if (inner.startsWith(" ") && inner.endsWith(" ") && !/^ *$/.test(inner)) {
    start += 1;
    end -= 1;
  }
  return source.slice(start, end) === value ? { start, end } : null;
}

function fencedCodeBounds(node: Element, value: string, source: string): Bounds | null {
  const bounds = positionBounds(node, source);
  if (!bounds) return null;
  const raw = source.slice(bounds.start, bounds.end);
  const opening = /^(`{3,}|~{3,})[^\r\n]*(?:\r\n|\n|\r)/.exec(raw);
  if (!opening) return null;
  const start = bounds.start + opening[0].length;
  const lastLine = Math.max(raw.lastIndexOf("\n"), raw.lastIndexOf("\r")) + 1;
  const closing = new RegExp(`^ {0,3}${opening[1][0]}{${opening[1].length},}[ \\t]*$`);
  const closed = lastLine >= opening[0].length && closing.test(raw.slice(lastLine));
  const end = closed ? bounds.start + lastLine : bounds.end;
  const body = source.slice(start, end);
  if (body === value) return { start, end };
  if (!closed && value.endsWith("\n") && body === value.slice(0, -1)) return { start, end };
  return null;
}

function classes(node: Element): string[] {
  const value: unknown = node.properties.className;
  return Array.isArray(value) ? value.map(String) : typeof value === "string" ? value.split(/\s+/) : [];
}

function codeLanguage(node: Element): string | null {
  const label = classes(node).find((name) => name.startsWith("language-"))?.slice(9).toLowerCase();
  if (label === "typescript" || label === "ts" || label === "javascript" || label === "js") return "typescript";
  if (label === "json" || label === "sql") return label;
  return null;
}

function codeParts(value: string, language: string | null): TokenPart[] {
  const plain = [{ start: 0, end: value.length }];
  if (!language || !value) return plain;
  try {
    const engine = getHighlighter();
    const lines = engine.codeToTokensWithThemes(value, {
      lang: language,
      themes: { dark: "github-dark", light: "github-light" },
    });
    const parts: TokenPart[] = [];
    let cursor = 0;
    for (const line of lines) {
      for (const token of line) {
        if (!token.content) continue;
        const end = token.offset + token.content.length;
        if (!Number.isSafeInteger(token.offset) || token.offset < cursor || end > value.length
          || value.slice(token.offset, end) !== token.content
          || !/^[\r\n]*$/.test(value.slice(cursor, token.offset))) {
          throw new Error("Invalid syntax token offsets.");
        }
        if (token.offset > cursor) parts.push({ start: cursor, end: token.offset });
        const dark = token.variants.dark.color ?? engine.getTheme("github-dark").fg;
        const light = token.variants.light.color ?? engine.getTheme("github-light").fg;
        parts.push({
          start: token.offset,
          end,
          style: `--shiki-dark:${dark};--shiki-light:${light}`,
        });
        cursor = end;
      }
    }
    if (!/^[\r\n]*$/.test(value.slice(cursor))) throw new Error("Invalid syntax token coverage.");
    if (cursor < value.length) parts.push({ start: cursor, end: value.length });
    return parts;
  } catch {
    console.error("Syntax highlighting failed; displaying plain code without inferred token offsets.");
    return plain;
  }
}

function marker(thread: Thread, activeThreadId?: string | null): Element {
  return {
    type: "element",
    tagName: "button",
    properties: {
      className: ["anchor-marker", ...(thread.resolved ? ["is-resolved"] : []), ...(thread.id === activeThreadId ? ["is-active"] : [])],
      "data-thread-id": thread.id,
      "data-anchor-marker": thread.id,
      type: "button",
      ariaLabel: `Open thread: ${thread.title}`,
    },
    children: [{ type: "text", value: String(Math.max(1, thread.messageCount)) }],
  };
}

function markSpan(node: Element, thread: Thread, activeThreadId?: string | null) {
  node.properties.className = [
    ...classes(node),
    "md-anchor",
    ...(thread.resolved ? ["md-anchor-resolved"] : []),
    ...(thread.id === activeThreadId ? ["md-anchor-active"] : []),
  ];
  node.properties["data-thread-id"] = thread.id;
}

function applyAnchors(leaves: MappedLeaf[], anchors: Thread[], source: string, activeThreadId?: string | null) {
  const seen = new Set<string>();
  const valid = anchors.filter((anchor) => {
    if (!validateAnchor(source, anchor) || seen.has(anchor.id)) return false;
    seen.add(anchor.id);
    return true;
  });
  const lastLeaves = new Map<string, MappedLeaf>();
  for (const leaf of leaves) {
    for (const anchor of valid) {
      if (anchor.anchorStart < leaf.end && anchor.anchorEnd > leaf.start) lastLeaves.set(anchor.id, leaf);
    }
  }
  for (const leaf of leaves) {
    const intersecting = valid.filter((anchor) => anchor.anchorStart < leaf.end && anchor.anchorEnd > leaf.start);
    if (!intersecting.length) continue;
    const cuts = Array.from(new Set([
      leaf.start,
      leaf.end,
      ...intersecting.flatMap((anchor) => [Math.max(leaf.start, anchor.anchorStart), Math.min(leaf.end, anchor.anchorEnd)]),
    ])).sort((a, b) => a - b);
    const replacements: Element[] = [];
    for (let index = 1; index < cuts.length; index += 1) {
      const start = cuts[index - 1];
      const end = cuts[index];
      let span: Element = {
        type: "element",
        tagName: "span",
        properties: { ...leaf.element.properties, "data-md-start": start, "data-md-end": end },
        children: [{ type: "text", value: source.slice(start, end) }],
      };
      const covering = intersecting.filter((anchor) => anchor.anchorStart < end && anchor.anchorEnd > start);
      for (let position = 0; position < covering.length; position += 1) {
        if (position > 0) {
          span = {
            type: "element",
            tagName: "span",
            properties: { className: ["md-leaf"], "data-md-start": start, "data-md-end": end },
            children: [span],
          };
        }
        markSpan(span, covering[position], activeThreadId);
      }
      replacements.push(span);
      for (const anchor of covering) {
        if (lastLeaves.get(anchor.id) === leaf && end === Math.min(leaf.end, anchor.anchorEnd)) {
          replacements.push(marker(anchor, activeThreadId));
        }
      }
    }
    const index = leaf.parent.children.indexOf(leaf.element);
    leaf.parent.children.splice(index, 1, ...replacements);
  }
}

function isAnchorMarker(node: Element["children"][number]): boolean {
  return node.type === "element" && node.tagName === "button" && node.properties["data-anchor-marker"] !== undefined;
}

function splitAtMarkers(parent: Element): Element[] {
  if (isAnchorMarker(parent) || !parent.children.length) return [parent];
  const result: Element[] = [];
  let children: Element["children"] = [];
  const flush = () => {
    if (children.length) result.push({ ...parent, children });
    children = [];
  };
  for (const child of parent.children) {
    const parts = child.type === "element" ? splitAtMarkers(child) : [child];
    for (const part of parts) {
      if (part.type === "element" && isAnchorMarker(part)) { flush(); result.push(part); }
      else children.push(part);
    }
  }
  flush();
  return result;
}

function liftLinkMarkers(parent: Container) {
  for (let index = 0; index < parent.children.length; index += 1) {
    const child = parent.children[index];
    if (child.type !== "element") continue;
    if (child.tagName === "a") {
      const parts = splitAtMarkers(child);
      parent.children.splice(index, 1, ...parts);
      index += parts.length - 1;
    } else liftLinkMarkers(child);
  }
}

export function rehypeSourcePositions(options: {
  source: string;
  anchors?: Thread[];
  activeThreadId?: string | null;
}): (tree: Root) => void {
  return (tree) => {
    const { source, anchors = [], activeThreadId } = options;
    const leaves: MappedLeaf[] = [];

    function leaf(value: string, parent: Container, start?: number, style?: string, synthetic = false): Element {
      const properties: Properties = { className: ["md-leaf", ...(style ? ["code-token"] : [])] };
      if (style) properties.style = style;
      const element: Element = { type: "element", tagName: "span", properties, children: [{ type: "text", value }] };
      if (start !== undefined && Number.isSafeInteger(start) && start >= 0
        && start + value.length <= source.length && source.slice(start, start + value.length) === value) {
        properties["data-md-start"] = start;
        properties["data-md-end"] = start + value.length;
        if (value.length) leaves.push({ element, parent, start, end: start + value.length });
      } else if (synthetic && whitespace(value)) {
        properties["data-md-synthetic"] = "true";
      } else {
        properties["data-md-unsafe"] = "true";
      }
      return element;
    }

    function mapCode(node: Element, block: boolean) {
      if (node.children.length !== 1 || node.children[0].type !== "text") {
        mapChildren(node);
        return;
      }
      const value = node.children[0].value;
      if (!value) {
        node.children = [];
        return;
      }
      const bounds = block ? fencedCodeBounds(node, value, source) : inlineCodeBounds(node, value, source);
      const parts = codeParts(value, block ? codeLanguage(node) : null);
      const children: Element[] = [];
      for (const part of parts) {
        if (!bounds) {
          children.push(leaf(value.slice(part.start, part.end), node, undefined, part.style));
          continue;
        }
        const length = bounds.end - bounds.start;
        if (part.start < length) {
          children.push(leaf(value.slice(part.start, Math.min(part.end, length)), node, bounds.start + part.start, part.style));
        }
        if (part.end > length) {
          children.push(leaf(value.slice(Math.max(part.start, length), part.end), node, undefined, part.style, true));
        }
      }
      node.children = children;
    }

    function mapChildren(parent: Container) {
      for (let index = 0; index < parent.children.length; index += 1) {
        const child = parent.children[index];
        if (child.type === "element") {
          if (child.tagName === "code") mapCode(child, parent.type === "element" && parent.tagName === "pre");
          else mapChildren(child);
        } else if (child.type === "text" && child.value) {
          if (!child.position && whitespace(child.value)) continue;
          const bounds = positionBounds(child, source);
          const start = bounds && source.slice(bounds.start, bounds.end) === child.value ? bounds.start : undefined;
          parent.children.splice(index, 1, leaf(child.value, parent, start));
        }
      }
    }

    mapChildren(tree);
    applyAnchors(leaves, anchors, source, activeThreadId);
    liftLinkMarkers(tree);
  };
}

function selectionError(reason: string): never {
  const message = `Selection mapping failed: ${reason}`;
  console.error(message);
  throw new Error(message);
}

function ancestor(node: Node, root: HTMLElement, selector: string): HTMLElement | null {
  const match = node.parentElement?.closest<HTMLElement>(selector);
  return match && root.contains(match) ? match : null;
}

function ignoredUi(node: Node, root: HTMLElement): boolean {
  return ancestor(node, root, "[data-md-ui], [data-anchor-marker]") !== null;
}

function syntheticText(node: Text, root: HTMLElement): boolean {
  if (!ancestor(node, root, "[data-md-synthetic]")) return false;
  if (!whitespace(node.data)) selectionError("Synthetic whitespace no longer matches the rendered structure.");
  return true;
}

type VerifiedLeaf = Bounds & { offsets: Map<Text, number> };

function verifyDomLeaf(leaf: HTMLElement, source: string): VerifiedLeaf {
  if (leaf.tagName.toLowerCase() !== "span") selectionError("Source positions must belong to a text leaf.");
  const startAttribute = leaf.getAttribute("data-md-start");
  const endAttribute = leaf.getAttribute("data-md-end");
  if (startAttribute === null || endAttribute === null
    || !/^(0|[1-9]\d*)$/.test(startAttribute) || !/^(0|[1-9]\d*)$/.test(endAttribute)) {
    selectionError("A text leaf has invalid source positions.");
  }
  const start = Number(startAttribute);
  const end = Number(endAttribute);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > source.length) {
    selectionError("A text leaf has out-of-bounds source positions.");
  }
  const offsets = new Map<Text, number>();
  const walker = leaf.ownerDocument.createTreeWalker(leaf, NodeFilter.SHOW_TEXT);
  let content = "";
  for (let current = walker.nextNode(); current; current = walker.nextNode()) {
    const text = current as Text;
    if (ignoredUi(text, leaf)) continue;
    if (ancestor(text, leaf, "[data-md-unsafe]")) selectionError("A text leaf contains unmappable content.");
    if (syntheticText(text, leaf)) continue;
    offsets.set(text, content.length);
    content += text.data;
  }
  if (source.slice(start, end) !== content) selectionError("A rendered text leaf does not match its source range.");
  return { start, end, offsets };
}

export function mapSelectionToSource(
  root: HTMLElement,
  range: Range,
  source: string,
): { anchorStart: number; anchorEnd: number; anchorExact: string } {
  if (range.collapsed) throw new Error("Select nonempty markdown text to open a thread.");
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) {
    selectionError("The selection is outside this markdown message.");
  }
  const cache = new Map<HTMLElement, VerifiedLeaf>();
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let anchorStart: number | null = null;
  let anchorEnd = 0;
  for (let current = walker.nextNode(); current; current = walker.nextNode()) {
    const text = current as Text;
    if (!text.length || range.comparePoint(text, text.length) < 0 || range.comparePoint(text, 0) > 0) continue;
    const from = range.startContainer === text ? range.startOffset : 0;
    const to = range.endContainer === text ? range.endOffset : text.length;
    if (to <= from || ignoredUi(text, root)) continue;
    if (ancestor(text, root, "[data-md-unsafe]")) selectionError("The selection includes text that cannot be mapped exactly.");
    if (syntheticText(text, root)) continue;
    const leaf = ancestor(text, root, ".md-leaf");
    if (!leaf) {
      if (whitespace(text.data)) continue;
      selectionError("The selection includes text without verified source positions.");
    }
    let verified = cache.get(leaf);
    if (!verified) {
      verified = verifyDomLeaf(leaf, source);
      cache.set(leaf, verified);
    }
    const offset = verified.offsets.get(text);
    if (offset === undefined) selectionError("A selected text node is not part of its verified leaf.");
    const start = verified.start + offset + from;
    const end = verified.start + offset + to;
    if (end > verified.end || source.slice(start, end) !== text.data.slice(from, to)) {
      selectionError("Selected leaf text does not match the original source.");
    }
    if (anchorStart !== null && start < anchorEnd) selectionError("Selected source ranges overlap or are out of order.");
    anchorStart ??= start;
    anchorEnd = end;
  }
  if (anchorStart === null || anchorEnd <= anchorStart) throw new Error("Select nonempty markdown text to open a thread.");
  return { anchorStart, anchorEnd, anchorExact: source.slice(anchorStart, anchorEnd) };
}
