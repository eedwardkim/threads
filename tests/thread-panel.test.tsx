import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ThreadPanel } from "../components/thread-panel";
import type { ThreadData } from "../lib/types";

function renderQuote(source: string): HTMLElement {
  const data: ThreadData = {
    thread: {
      id: "thread", chatId: "chat", parentMessageId: "parent", anchorStart: 0, anchorEnd: source.length,
      anchorExact: source, compressedContext: null, contextFrozenAt: null, source: "user",
      resolved: false, title: "Math quote", createdAt: 1, anchorValid: true, messageCount: 0,
    },
    parentMessage: {
      id: "parent", chatId: "chat", threadId: null, role: "assistant", content: source,
      modelKey: "fast", complete: true, inputTokens: null, outputTokens: null, createdAt: 0,
    },
    messages: [],
    context: { tokens: 0, fullTokens: 0, actual: false, newMessages: 0, fallback: true, briefing: null },
  };
  const root = document.createElement("div");
  root.innerHTML = renderToStaticMarkup(
    <ThreadPanel id="thread" data={data} narrow={false} unavailable={false}
      providerStatus={{ mock: true, deepseek: false, anthropic: false, openai: false }}
      onClose={() => {}} onResolve={() => {}} onDelete={() => {}} onRefreshContext={() => {}} />,
  );
  const quote = root.querySelector<HTMLElement>(".thread-quote");
  if (!quote) throw new Error("Missing thread quote");
  expect(data.thread.anchorExact).toBe(source);
  expect(data.parentMessage.content).toBe(source);
  return quote;
}

describe("thread quote Markdown", () => {
  it("renders inline and display math with KaTeX while preserving the quoted source", () => {
    const quote = renderQuote("Inline $x^2$ and display:\n\n$$\n\\frac{a}{b}\n$$");
    expect(quote.querySelectorAll(".katex")).toHaveLength(2);
    expect(quote.querySelectorAll(".katex-display")).toHaveLength(1);
    expect(quote.querySelector("p .katex")).not.toBeNull();
    expect(quote.querySelector(".katex-display .katex")).not.toBeNull();
    expect(Array.from(quote.querySelectorAll('annotation[encoding="application/x-tex"]'), (item) => item.textContent))
      .toEqual(["x^2", "\\frac{a}{b}"]);
    expect(quote.querySelector(".katex-error")).toBeNull();
  });

  it("keeps dollar-delimited code literal and retains GFM formatting", () => {
    const quote = renderQuote("~~Old~~ **new** `$x^2$`\n\n```text\n$$\nx^2\n$$\n```");
    expect(quote.querySelector("del")?.textContent).toBe("Old");
    expect(quote.querySelector("strong")?.textContent).toBe("new");
    expect(quote.querySelector("p code")?.textContent).toBe("$x^2$");
    expect(quote.querySelector("pre code")?.textContent).toBe("$$\nx^2\n$$\n");
    expect(quote.querySelector(".katex")).toBeNull();
  });
});
