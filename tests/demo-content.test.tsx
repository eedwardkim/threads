import { spawnSync } from "node:child_process";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown } from "../components/markdown";
import { DEMO_FOLDERS } from "../lib/demo-catalog";
import { conversations as algebra } from "../lib/demo-linear-algebra";
import { conversations as bernstein } from "../lib/demo-bernstein";
import { conversations as psychology } from "../lib/demo-psychology";
import { conversations as core, pythonExamples as coreExamples } from "../lib/demo-cs61a-core";
import { conversations as functions, pythonExamples as functionExamples } from "../lib/demo-cs61a-functions";
import type { Thread } from "../lib/types";

const conversations = [...algebra, ...bernstein, ...psychology, ...core, ...functions];
const examples = [...coreExamples, ...functionExamples];

describe("authored demo content", () => {
  it("matches the metadata catalog exactly without duplicate IDs", () => {
    const ids = conversations.map((chat) => chat.id).sort();
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(DEMO_FOLDERS.flatMap((folder) => folder.chats.map((chat) => chat.id)).sort());
    expect(examples).toHaveLength(40);
    expect(new Set(examples.map((example) => example.name)).size).toBe(examples.length);
    const threads = conversations.flatMap((chat) => chat.exchanges.flatMap((exchange) => exchange.threads));
    expect(threads).toHaveLength(81);
    expect(threads.filter((thread) => thread.resolved)).toHaveLength(54);
    expect(conversations.reduce((total, chat) => total + chat.exchanges.length * 2, 0) + threads.reduce((total, thread) => total + thread.exchanges.length * 2, 0)).toBe(486);
  });

  it.each(conversations)("renders valid math and every clickable thread anchor in $id", (chat) => {
    expect(chat.exchanges).toHaveLength(3);
    expect(chat.goal.length).toBeGreaterThan(30);
    expect(chat.sources.length).toBeGreaterThan(0);
    for (const [index, exchange] of chat.exchanges.entries()) {
      expect(exchange.summary.length).toBeGreaterThan(30);
      expect(exchange.threads.length).toBeGreaterThanOrEqual(1);
      const anchors: Thread[] = exchange.threads.map((thread, branch) => {
        const start = exchange.assistant.indexOf(thread.quote);
        expect(start, `${chat.id}: ${thread.title}`).toBeGreaterThanOrEqual(0);
        expect(exchange.assistant.lastIndexOf(thread.quote)).toBe(start);
        return {
          id: `anchor-${index}-${branch}`, chatId: chat.id, parentMessageId: `parent-${index}`,
          anchorStart: start, anchorEnd: start + thread.quote.length, anchorExact: thread.quote,
          compressedContext: null, contextFrozenAt: null, source: "user", resolved: thread.resolved,
          title: thread.title, createdAt: 1, anchorValid: true, messageCount: thread.exchanges.length * 2,
        };
      });
      const root = document.createElement("div");
      root.innerHTML = renderToStaticMarkup(<Markdown content={exchange.assistant} anchors={anchors} selectable />);
      expect(root.querySelector(".katex-error"), `${chat.id}: main ${index}`).toBeNull();
      for (const anchor of anchors) {
        expect(root.querySelector(`[data-thread-id="${anchor.id}"][data-anchor-marker]`), `${chat.id}: ${anchor.title}`).not.toBeNull();
      }
      const texts = [exchange.user, exchange.assistant, ...exchange.threads.flatMap((thread) => thread.exchanges.flatMap((reply) => [reply.user, reply.assistant]))];
      for (const text of texts) {
        expect(text).not.toContain("\u0000");
        expect(text.trim().length).toBeGreaterThan(20);
      }
      for (const reply of exchange.threads.flatMap((thread) => thread.exchanges)) {
        root.innerHTML = renderToStaticMarkup(<Markdown content={reply.assistant} />);
        expect(root.querySelector(".katex-error"), `${chat.id}: ${reply.user}`).toBeNull();
      }
    }
  });
});

const pythonAvailable = spawnSync("python3", ["--version"], { timeout: 5_000 }).status === 0;

it.skipIf(!pythonAvailable)("executes every CS61A worked example with the documented output and exception", () => {
  const run = spawnSync("python3", ["-c", `import contextlib, io, json, sys
results = []
for example in json.load(sys.stdin):
    output = io.StringIO()
    error = None
    with contextlib.redirect_stdout(output):
        try:
            exec(example["code"], {"__name__": "__main__"})
        except Exception as exc:
            error = type(exc).__name__
    results.append({"name": example["name"], "stdout": output.getvalue(), "error": error})
print(json.dumps(results))`], { input: JSON.stringify(examples), encoding: "utf8", timeout: 10_000 });
  expect(run.status, run.stderr).toBe(0);
  const results = JSON.parse(run.stdout) as { name: string; stdout: string; error: string | null }[];
  for (const [index, example] of examples.entries()) {
    expect(results[index], example.name).toEqual({ name: example.name, stdout: example.stdout, error: example.error ?? null });
  }
});
