import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateAnchor } from "../lib/anchors";
import { mapSelectionToSource, rehypeSourcePositions } from "../lib/markdown-offsets";
import { normalizeMathDelimiters } from "../lib/math";
import type { Thread } from "../lib/types";

function renderMarkdown(
  source: string,
  options: { anchors?: Thread[]; activeThreadId?: string | null } = {},
): HTMLDivElement {
  const root = document.createElement("div");
  root.innerHTML = renderToStaticMarkup(
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[[rehypeSourcePositions, { source, ...options }]]}
    >
      {source}
    </ReactMarkdown>,
  );
  document.body.append(root);
  return root;
}

function element(root: ParentNode, selector: string): HTMLElement {
  const match = root.querySelector<HTMLElement>(selector);
  if (!match) throw new Error(`Missing test element: ${selector}`);
  return match;
}

function textNode(root: Node, content: string, occurrence = 0): Text {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const matches: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.textContent?.includes(content)) matches.push(node as Text);
  }
  const match = matches[occurrence];
  if (!match) throw new Error("Missing test text node");
  return match;
}

function between(start: Node, startOffset: number, end: Node, endOffset: number): Range {
  const range = document.createRange();
  range.setStart(start, startOffset);
  range.setEnd(end, endOffset);
  return range;
}

function contents(node: Node): Range {
  const range = document.createRange();
  range.selectNodeContents(node);
  return range;
}

function expectMapping(root: HTMLElement, range: Range, source: string, start: number, end: number) {
  const anchor = mapSelectionToSource(root, range, source);
  expect(anchor).toEqual({
    anchorStart: start,
    anchorEnd: end,
    anchorExact: source.slice(start, end),
  });
  expect(validateAnchor(source, anchor)).toBe(true);
  return anchor;
}

function expectVerifiedLeaves(root: ParentNode, source: string) {
  const leaves = root.querySelectorAll<HTMLElement>(".md-leaf[data-md-start][data-md-end]");
  expect(leaves.length).toBeGreaterThan(0);
  for (const leaf of leaves) {
    expect(source.slice(Number(leaf.dataset.mdStart), Number(leaf.dataset.mdEnd))).toBe(leaf.textContent);
  }
}

function thread(source: string, start: number, end: number, overrides: Partial<Thread> = {}): Thread {
  return {
    id: "thread-a",
    chatId: "chat-a",
    parentMessageId: "message-a",
    anchorStart: start,
    anchorEnd: end,
    anchorExact: source.slice(start, end),
    compressedContext: null,
    contextFrozenAt: null,
    source: "user",
    resolved: false,
    title: "A useful question",
    createdAt: 1,
    anchorValid: true,
    messageCount: 2,
    ...overrides,
  };
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("markdown source selections", () => {
  it("maps a plain paragraph through a positioned text leaf, not its block", () => {
    const source = "A plain paragraph with a reliable answer.";
    const root = renderMarkdown(source);
    const paragraph = element(root, "p");
    const text = textNode(paragraph, "plain paragraph");
    const start = source.indexOf("plain paragraph");
    expectMapping(root, between(text, start, text, start + 15), source, start, start + 15);
    expect(paragraph.hasAttribute("data-md-start")).toBe(false);
    expect(element(paragraph, ":scope > span.md-leaf").dataset.mdStart).toBe("0");
    expectVerifiedLeaves(root, source);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("retains bold delimiters and the full markdown link across visible leaves", () => {
    const source = "Start **bold words** then [a link](https://example.test/path) finish.";
    const root = renderMarkdown(source);
    const start = textNode(root, "Start ");
    const end = textNode(root, " finish.");
    const range = between(start, 2, end, end.length - 1);
    const anchor = expectMapping(root, range, source, 2, source.length - 1);
    expect(anchor.anchorExact).toContain("**bold words**");
    expect(anchor.anchorExact).toContain("[a link](https://example.test/path)");
    expect(range.toString()).not.toBe(anchor.anchorExact);
    expectVerifiedLeaves(root, source);
  });

  it("maps partial bold and link text endpoints without absorbing unselected delimiters", () => {
    const source = "Start **bold words** then [a link](https://example.test) finish.";
    const root = renderMarkdown(source);
    const bold = textNode(element(root, "strong"), "bold words");
    const link = textNode(element(root, "a"), "a link");
    expectMapping(
      root,
      between(bold, 2, link, 5),
      source,
      source.indexOf("bold words") + 2,
      source.indexOf("a link") + 5,
    );
  });

  it("maps a list item without counting list markers or synthetic list whitespace", () => {
    const source = "- First item\n- Second item with **weight**";
    const root = renderMarkdown(source);
    const second = element(root, "li:nth-of-type(2)");
    const text = textNode(second, "Second item");
    const start = source.indexOf("Second item");
    expectMapping(root, between(text, 0, text, 11), source, start, start + 11);
    expectVerifiedLeaves(root, source);
  });

  it("preserves valid table structure while mapping cells across raw table delimiters", () => {
    const source = "| Name | Value |\n| --- | --- |\n| note | saved |";
    const root = renderMarkdown(source);
    const table = element(root, "table");
    expect(root.querySelector(":scope > .md-leaf")).toBeNull();
    expect(table.querySelector("tr > .md-leaf")).toBeNull();
    expectMapping(root, contents(table), source, source.indexOf("Name"), source.indexOf("saved") + 5);
    expectVerifiedLeaves(root, source);
  });

  it("maps a paragraph into the next block and keeps the raw block separator", () => {
    const source = "First paragraph.\n\n## Second block";
    const root = renderMarkdown(source);
    const first = textNode(element(root, "p"), "First paragraph.");
    const second = textNode(element(root, "h2"), "Second block");
    const anchor = expectMapping(
      root,
      between(first, 6, second, 6),
      source,
      6,
      source.indexOf("Second block") + 6,
    );
    expect(anchor.anchorExact).toBe("paragraph.\n\n## Second");
  });

  it("disambiguates repeated text using positions rather than searching for text", () => {
    const source = "Same words.\n\nSame words.";
    const root = renderMarkdown(source);
    const text = textNode(element(root, "p:nth-of-type(2)"), "Same words.");
    const start = source.lastIndexOf("Same words.");
    expectMapping(root, between(text, 0, text, 4), source, start, start + 4);
  });

  it("supports select-all element endpoints and exact internal element boundaries", () => {
    const source = "First **bold** piece.\n\nSecond [link](https://example.test) piece.";
    const root = renderMarkdown(source);
    expectMapping(root, contents(root), source, 0, source.length);
    const bold = element(root, "strong");
    const link = element(root, "a");
    expectMapping(
      root,
      between(bold, 0, link, link.childNodes.length),
      source,
      source.indexOf("bold"),
      source.indexOf("link") + 4,
    );
    const paragraph = element(root, "p");
    expectMapping(root, between(paragraph, 0, paragraph, 1), source, 0, 6);
  });

  it("counts nested styling spans only within an exactly verified leaf", () => {
    const source = "nested styling works";
    const root = renderMarkdown(source);
    const leaf = element(root, ".md-leaf");
    leaf.replaceChildren();
    const first = document.createElement("span");
    first.textContent = "nested ";
    const middle = document.createElement("span");
    middle.innerHTML = "<span>styling</span>";
    const last = document.createElement("span");
    last.textContent = " works";
    leaf.append(first, middle, last);
    const start = textNode(first, "nested ");
    const end = textNode(last, " works");
    expectMapping(root, between(start, 3, end, 3), source, 3, 17);
  });

  it("ignores marked toolbars even when their text is inside a positioned leaf", () => {
    const source = "A reliable answer.";
    const root = renderMarkdown(source);
    const leaf = element(root, ".md-leaf");
    const toolbar = document.createElement("span");
    toolbar.dataset.mdUi = "true";
    toolbar.innerHTML = "<button type='button'>Copy code</button>";
    leaf.prepend(toolbar);
    expectMapping(root, contents(root), source, 0, source.length);
    expect(() => mapSelectionToSource(root, contents(toolbar), source)).toThrow();
  });

  it("uses UTF-16 offsets and keeps the exact stored source checksum", () => {
    const source = "A 𐐷 points to **naïve café** today.";
    const root = renderMarkdown(source);
    const text = textNode(element(root, "strong"), "naïve café");
    const start = source.indexOf("café");
    const result = expectMapping(root, between(text, 6, text, 10), source, start, start + 4);
    expect(result.anchorExact).toBe("café");
    expect(validateAnchor(`${source.slice(0, start)}CAFE${source.slice(start + 4)}`, result)).toBe(false);
  });
});

describe("code source selections", () => {
  const source = "Intro.\n\n```typescript\nconst answer: number = 42;\nconsole.log(answer);\n```\n\nAfter.";

  it("highlights TypeScript with fine-grained dual-theme tokens and maps inside a token", () => {
    const root = renderMarkdown(source);
    const code = element(root, "pre code");
    const tokens = code.querySelectorAll<HTMLElement>(".code-token");
    expect(tokens.length).toBeGreaterThan(8);
    for (const token of tokens) {
      expect(token.style.getPropertyValue("--shiki-dark")).not.toBe("");
      expect(token.style.getPropertyValue("--shiki-light")).not.toBe("");
    }
    const answer = textNode(code, "answer");
    const start = source.indexOf("answer") + 1;
    expectMapping(root, between(answer, 1, answer, 4), source, start, start + 3);
    expectVerifiedLeaves(root, source);
  });

  it("maps across tokens and lines while retaining real newlines but excluding fences", () => {
    const root = renderMarkdown(source);
    const code = element(root, "pre code");
    const first = textNode(code, "answer", 0);
    const second = textNode(code, "answer", 1);
    const start = source.indexOf("answer") + 2;
    const end = source.lastIndexOf("answer") + 3;
    const anchor = expectMapping(root, between(first, 2, second, second.data.indexOf("answer") + 3), source, start, end);
    expect(anchor.anchorExact).toContain("\n");
    expect(anchor.anchorExact).not.toContain("```");
    const bodyStart = source.indexOf("const answer");
    const bodyEnd = source.indexOf("\n```", bodyStart) + 1;
    expectMapping(root, contents(code), source, bodyStart, bodyEnd);
    expect(code.textContent).toBe(source.slice(bodyStart, bodyEnd));
  });

  it("derives each repeated fenced block from its own opening fence", () => {
    const source = "```ts\nconst repeated = 1;\n```\n\nText.\n\n```ts\nconst repeated = 1;\n```";
    const root = renderMarkdown(source);
    const second = element(root, "pre:nth-of-type(2) code");
    const text = textNode(second, "repeated");
    const start = source.lastIndexOf("repeated");
    expectMapping(root, between(text, 0, text, text.length), source, start, start + 8);
  });

  it("distinguishes an unclosed fence's synthetic newline from a real source newline", () => {
    const source = "```typescript\nconst value = 1;";
    const root = renderMarkdown(source);
    const code = element(root, "code");
    expect(code.textContent).toBe("const value = 1;\n");
    expectMapping(root, contents(code), source, source.indexOf("const"), source.length);
    expectVerifiedLeaves(code, source);
  });

  it.each(["\n", "\n\n"])("preserves real trailing newlines in an unclosed fence: %j", (ending) => {
    const source = `\`\`\`typescript\nconst value = 1;${ending}`;
    const root = renderMarkdown(source);
    const code = element(root, "code");
    expect(code.querySelector("[data-md-synthetic]")).toBeNull();
    expectMapping(root, contents(code), source, source.indexOf("const"), source.length);
    expectVerifiedLeaves(code, source);
  });

  it("handles longer fences, opening metadata, and closing indentation without guessing body offsets", () => {
    const body = "const value = 1;\n\n  console.log(value);\n";
    const source = `\`\`\`\`typescript example\n${body}  \`\`\`\`\`   \n\nAfter.`;
    const root = renderMarkdown(source);
    const code = element(root, "code");
    const start = source.indexOf(body);
    expectMapping(root, contents(code), source, start, start + body.length);
    expectVerifiedLeaves(code, source);
  });

  it.each([
    ["json", '{"answer": 42}'],
    ["sql", "SELECT id FROM notes;"],
    ["javascript", "const answer = 42;"],
    ["js", "const answer = 42;"],
  ])("highlights the explicitly supported %s grammar", (language, body) => {
    const source = `~~~${language}\n${body}\n~~~`;
    const root = renderMarkdown(source);
    const code = element(root, "code");
    expect(code.querySelectorAll(".code-token").length).toBeGreaterThan(1);
    expectMapping(root, contents(code), source, source.indexOf(body), source.indexOf(body) + body.length + 1);
    expectVerifiedLeaves(code, source);
  });

  it("keeps unknown fenced languages plain and exactly selectable", () => {
    const source = "```not-a-bundled-language\nplain code\n```";
    const root = renderMarkdown(source);
    const code = element(root, "code");
    expect(code.querySelector(".code-token")).toBeNull();
    expectMapping(root, contents(code), source, source.indexOf("plain code"), source.indexOf("\n```", 4) + 1);
  });

  it.each([
    ["Use `inline code` here.", "inline code"],
    ["Use `` a`b `` here.", "a`b"],
  ])("derives exact inner offsets for inline code in %s", (source, body) => {
    const root = renderMarkdown(source);
    const code = element(root, "code");
    expectMapping(root, contents(code), source, source.indexOf(body), source.indexOf(body) + body.length);
    expectVerifiedLeaves(root, source);
  });

  it.each([
    "  ```typescript\n  const value = 1;\n  console.log(value);\n  ```",
    "    const value = 1;\n    console.log(value);",
    "```typescript\r\nconst value = 1;\r\n```",
    "Use `one\ntwo` here.",
  ])("fails closed when markdown normalizes code indentation or line breaks: %s", (source) => {
    const root = renderMarkdown(source);
    const code = element(root, "code");
    expect(() => mapSelectionToSource(root, contents(code), source)).toThrow();
    expect(console.error).toHaveBeenCalled();
  });
});

describe("unsafe source selections", () => {
  it.each(["Fish &amp; chips", "A \\*literal\\* example", "A &#65; letter", "&nbsp;"])(
    "rejects entity or escape decoding rather than guessing offsets: %s",
    (source) => {
      const root = renderMarkdown(source);
      expect(() => mapSelectionToSource(root, contents(root), source)).toThrow();
      expect(console.error).toHaveBeenCalled();
      expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(source);
    },
  );

  it("rejects tampered offsets and logs no private text", () => {
    const source = "Confidential words here.\n\nAnother paragraph.";
    const root = renderMarkdown(source);
    const leaf = element(root, "p .md-leaf");
    leaf.dataset.mdStart = "1";
    leaf.dataset.mdEnd = String(Number(leaf.dataset.mdEnd) + 1);
    expect(() => mapSelectionToSource(root, contents(leaf), source)).toThrow();
    expect(console.error).toHaveBeenCalled();
    const logged = JSON.stringify(vi.mocked(console.error).mock.calls);
    expect(logged).not.toContain("Confidential words");
    expect(logged).not.toContain(source);
  });

  it.each(["1.5", "0junk", "-1", "", "Infinity"])("rejects malformed offset %s", (offset) => {
    const source = "A plain paragraph.";
    const root = renderMarkdown(source);
    element(root, ".md-leaf").dataset.mdStart = offset;
    expect(() => mapSelectionToSource(root, contents(root), source)).toThrow();
  });

  it("validates an entire nested leaf before counting its selected substring", () => {
    const source = "A reliable answer.";
    const root = renderMarkdown(source);
    const leaf = element(root, ".md-leaf");
    leaf.append(document.createTextNode(" changed"));
    const text = textNode(leaf, "A reliable answer.");
    expect(() => mapSelectionToSource(root, between(text, 0, text, 1), source)).toThrow();
    expect(console.error).toHaveBeenCalled();
  });

  it("rejects unpositioned non-UI text instead of counting from an arbitrary block", () => {
    const source = "A plain paragraph.";
    const root = renderMarkdown(source);
    const paragraph = element(root, "p");
    paragraph.dataset.mdStart = "0";
    paragraph.dataset.mdEnd = String(source.length);
    paragraph.replaceChildren(document.createTextNode(source));
    expect(() => mapSelectionToSource(root, contents(paragraph), source)).toThrow();
    expect(console.error).toHaveBeenCalled();
  });

  it("does not ignore non-whitespace tampered into a synthetic newline", () => {
    const source = "```typescript\nconst value = 1;";
    const root = renderMarkdown(source);
    element(root, "[data-md-synthetic]").textContent = "Unexpected content";
    expect(() => mapSelectionToSource(root, contents(root), source)).toThrow();
    expect(console.error).toHaveBeenCalled();
  });

  it("rejects source positions that go backwards across otherwise matching leaves", () => {
    const source = "Same words.\n\nSame words.";
    const root = renderMarkdown(source);
    const leaves = root.querySelectorAll<HTMLElement>(".md-leaf[data-md-start]");
    leaves[1].dataset.mdStart = "0";
    leaves[1].dataset.mdEnd = String("Same words.".length);
    expect(() => mapSelectionToSource(root, contents(root), source)).toThrow();
  });

  it("refuses a cross-root range even when its text could match the source", () => {
    const source = "Same words.";
    const first = renderMarkdown(source);
    const second = renderMarkdown(source);
    const start = textNode(first, source);
    const end = textNode(second, source);
    expect(() => mapSelectionToSource(first, between(start, 0, end, 4), source)).toThrow();
  });

  it("rejects collapsed ranges without logging an error", () => {
    const source = "A paragraph.";
    const root = renderMarkdown(source);
    const text = textNode(root, source);
    expect(() => mapSelectionToSource(root, between(text, 2, text, 2), source)).toThrow();
    expect(console.error).not.toHaveBeenCalled();
  });
});

describe("inline thread anchors", () => {
  it("splits leaves across blocks and appends exactly one active, resolved marker", () => {
    const source = "First **bold** paragraph.\n\nSecond [linked](https://example.test) paragraph.";
    const anchor = thread(source, 2, source.indexOf("linked") + 6, { resolved: true });
    const root = renderMarkdown(source, { anchors: [anchor], activeThreadId: anchor.id });
    const highlighted = root.querySelectorAll<HTMLElement>(".md-anchor");
    expect(highlighted.length).toBeGreaterThan(3);
    for (const span of highlighted) {
      expect(span.dataset.threadId).toBe(anchor.id);
      expect(span.classList.contains("md-anchor-active")).toBe(true);
      expect(span.classList.contains("md-anchor-resolved")).toBe(true);
      expect(span.hasAttribute("role")).toBe(false);
    }
    const markers = root.querySelectorAll<HTMLButtonElement>("button[data-anchor-marker]");
    expect(markers).toHaveLength(1);
    const marker = markers[0];
    expect(marker.dataset.anchorMarker).toBe(anchor.id);
    expect(marker.dataset.threadId).toBe(anchor.id);
    expect(marker.type).toBe("button");
    expect(marker.getAttribute("aria-label")).toBe(`Open thread: ${anchor.title}`);
    expect(marker.textContent).toBe("2");
    expect(marker.classList.contains("anchor-marker")).toBe(true);
    expect(marker.classList.contains("is-active")).toBe(true);
    expect(marker.classList.contains("is-resolved")).toBe(true);
    expect(marker.closest("p")).toBe(root.querySelectorAll("p")[1]);
    expect(marker.closest("a")).toBeNull();
    expectVerifiedLeaves(root, source);
    expectMapping(root, contents(root), source, 0, source.length);
  });

  it("renders independent anchors at their exact split boundaries, with a minimum count of one", () => {
    const source = "alpha middle omega";
    const first = thread(source, 0, 5, { messageCount: 0 });
    const second = thread(source, source.indexOf("omega"), source.length, { id: "thread-b", messageCount: 4 });
    const root = renderMarkdown(source, { anchors: [first, second], activeThreadId: second.id });
    const anchors = root.querySelectorAll<HTMLElement>(".md-anchor");
    expect(Array.from(anchors, (span) => span.textContent)).toEqual(["alpha", "omega"]);
    expect(anchors[0].dataset.mdStart).toBe("0");
    expect(anchors[0].dataset.mdEnd).toBe("5");
    expect(anchors[0].classList.contains("md-anchor-active")).toBe(false);
    expect(anchors[1].classList.contains("md-anchor-active")).toBe(true);
    const markers = root.querySelectorAll<HTMLElement>(".anchor-marker");
    expect(Array.from(markers, (marker) => marker.textContent)).toEqual(["1", "4"]);
    expect(markers[0].previousElementSibling).toBe(anchors[0]);
    expect(markers[1].previousElementSibling).toBe(anchors[1]);
    expectMapping(root, contents(root), source, 0, source.length);
    expectVerifiedLeaves(root, source);
  });

  it("deduplicates thread IDs and treats marker-only selections as empty markdown", () => {
    const source = "A useful passage.";
    const anchor = thread(source, 0, source.length);
    const root = renderMarkdown(source, { anchors: [anchor, { ...anchor }] });
    expect(root.querySelectorAll(".anchor-marker")).toHaveLength(1);
    expect(() => mapSelectionToSource(root, contents(element(root, ".anchor-marker")), source)).toThrow();
    expect(console.error).not.toHaveBeenCalled();
    expectMapping(root, contents(root), source, 0, source.length);
  });

  it("skips invalid exact-text checksums without rendering a marker", () => {
    const source = "A useful passage.";
    const anchor = thread(source, 0, source.length, { anchorExact: "Stale private content" });
    const root = renderMarkdown(source, { anchors: [anchor] });
    expect(root.querySelector(".md-anchor")).toBeNull();
    expect(root.querySelector(".anchor-marker")).toBeNull();
    expect(console.error).toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(anchor.anchorExact);
  });

  it("bubbles a marker outside an enclosing link, including nested strong and code", () => {
    const source = "Read [**linked `code` text**](https://example.test) next.";
    const start = source.indexOf("code");
    const anchor = thread(source, start, start + 4);
    const root = renderMarkdown(source, { anchors: [anchor] });
    const link = element(root, "a");
    const marker = element(root, "button.anchor-marker");
    expect(link.querySelector("button")).toBeNull();
    expect(marker.parentElement).toBe(link.parentElement);
    expect(link.nextElementSibling).toBe(marker);
    expect(link.textContent).toBe("linked code");
    expect(marker.nextElementSibling?.tagName).toBe("A");
    expect(marker.nextElementSibling?.textContent).toBe(" text");
    expect(element(link, "code .md-anchor").textContent).toBe("code");
    expectMapping(root, contents(root), source, 0, source.length);
  });

  it("keeps separate markers immediately after two spans inside one link", () => {
    const source = "[alpha middle omega](https://example.test)";
    const first = thread(source, 1, 6);
    const start = source.indexOf("omega");
    const second = thread(source, start, start + 5, { id: "thread-b" });
    const root = renderMarkdown(source, { anchors: [first, second] });
    const children = Array.from(element(root, "p").children);
    expect(children.map((child) => child.tagName)).toEqual(["A", "BUTTON", "A", "BUTTON"]);
    expect(children[0].textContent).toBe("alpha");
    expect(children[2].textContent).toBe(" middle omega");
    expect(root.querySelectorAll("a button")).toHaveLength(0);
    expectVerifiedLeaves(root, source);
    expectMapping(root, contents(root), source, 1, source.indexOf("]"));
  });

  it("places one marker after the final highlighted code token without polluting offsets", () => {
    const source = "```typescript\nconst answer = 42;\nconsole.log(answer);\n```";
    const start = source.indexOf("answer");
    const end = source.lastIndexOf("answer") + 6;
    const anchor = thread(source, start, end);
    const root = renderMarkdown(source, { anchors: [anchor] });
    const code = element(root, "code");
    const marker = element(code, ".anchor-marker");
    expect(root.querySelectorAll(".anchor-marker")).toHaveLength(1);
    expect(marker.previousElementSibling?.textContent?.endsWith("answer")).toBe(true);
    expect(marker.previousElementSibling?.getAttribute("data-md-end")).toBe(String(end));
    expect(marker.previousElementSibling?.classList.contains("code-token")).toBe(true);
    expectMapping(root, contents(code), source, source.indexOf("const"), source.indexOf("\n```", 4) + 1);
    expectVerifiedLeaves(root, source);
  });
});

describe("math source mapping", () => {
  function renderMath(source: string, options: { anchors?: Thread[]; activeThreadId?: string | null } = {}): HTMLDivElement {
    const root = document.createElement("div");
    root.innerHTML = renderToStaticMarkup(
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex, [rehypeSourcePositions, { source, ...options }]]}
      >
        {source}
      </ReactMarkdown>,
    );
    document.body.append(root);
    return root;
  }

  it("renders normalized LaTeX and maps anchors against the finalized source", () => {
    const source = normalizeMathDelimiters(String.raw`Inline \(x^2\). Display \[\binom{15}{3}=\boxed{455}\] Text after math.`);
    const start = source.indexOf("Text after math.");
    const anchor = thread(source, start, source.length);
    const root = renderMath(source, { anchors: [anchor] });
    expect(root.querySelectorAll(".katex")).toHaveLength(2);
    expect(root.querySelectorAll(".katex-display")).toHaveLength(1);
    expect(root.querySelector(".katex-error")).toBeNull();
    expect(element(root, ".md-anchor").textContent).toBe("Text after math.");
    const after = textNode(root, "Text after math.");
    expectMapping(root, contents(after), source, start, source.length);
    expectVerifiedLeaves(root, source);
  });

  it("renders inline and block math without crashing offset mapping around a thread anchor", () => {
    const source = "Energy is $E = mc^2$ in this note.\n\n$$\n\\int_0^1 x\\,dx\n$$\n\nPlain text after math.";
    const start = source.indexOf("this note");
    const end = start + "this note".length;
    const anchor = thread(source, start, end);
    const root = renderMath(source, { anchors: [anchor] });
    expect(root.querySelector(".katex")).not.toBeNull();
    expect(root.querySelector(".katex-display")).not.toBeNull();
    const math = root.querySelectorAll(".katex, .katex-display, .math, .math-inline, .math-display");
    expect(math.length).toBeGreaterThan(0);
    for (const node of math) {
      expect(node.closest("[data-md-unsafe]")).not.toBeNull();
    }
    expect(element(root, ".md-anchor").textContent).toBe("this note");
    expect(element(root, ".anchor-marker").dataset.threadId).toBe(anchor.id);
    const after = textNode(root, "Plain text after math.");
    expectMapping(root, between(after, 0, after, after.length), source, source.indexOf("Plain text after math."), source.length);
    expectVerifiedLeaves(root, source);
    expect(() => mapSelectionToSource(root, contents(element(root, ".katex")), source)).toThrow();
  });
});
