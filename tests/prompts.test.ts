import { describe, expect, it } from "vitest";
import { assembleMainPrompt, assembleThreadPrompt, MAIN_SYSTEM_PROMPT, renderBriefing } from "../lib/prompts";
import type { Briefing, FrozenContext, Message, Thread } from "../lib/types";

function message(input: Partial<Message> = {}): Message {
  return {
    id: "message", chatId: "chat", threadId: null, role: "user", content: "Question",
    modelKey: "fast", complete: true, inputTokens: null, outputTokens: null, createdAt: 1,
    ...input,
  };
}

function thread(context: FrozenContext | null = null): Thread {
  return {
    id: "thread", chatId: "chat", parentMessageId: "parent", anchorStart: 0, anchorEnd: 7,
    anchorExact: "Subject", compressedContext: context ? JSON.stringify(context) : null,
    contextFrozenAt: context ? 1 : null, source: "user", resolved: false, title: "Subject",
    createdAt: 2, anchorValid: true, messageCount: 0,
  };
}

const briefing: Briefing = {
  goal: "Preserve durable edits",
  constraints: ["Work offline", "Do not block reads"],
  decisions: ["Use a transaction"],
  artifacts: ["saveNote.ts\nwith the complete implementation"],
  open_questions: ["How should retries be scheduled?"],
};

describe("prompt assembly", () => {
  it("keeps the main system prefix byte-stable across calls and models", () => {
    expect(MAIN_SYSTEM_PROMPT).toBe("You are a thoughtful, precise assistant. Answer the user's request directly, and use Markdown where it improves clarity.");
    const first = assembleMainPrompt([message()]);
    const second = assembleMainPrompt([message({ modelKey: "thinking", content: "Another question" })]);
    expect(first[0]).toEqual({ role: "system", content: MAIN_SYSTEM_PROMPT });
    expect(new TextEncoder().encode(first[0].content)).toEqual(new TextEncoder().encode(second[0].content));
    expect(assembleMainPrompt([])).toEqual([first[0]]);
  });

  it("excludes every threaded row from main even when a caller passes mixed history", () => {
    const rows = [
      message({ id: "one", content: "  Main question\n" }),
      message({ id: "branch", threadId: "thread", content: "Private branch" }),
      message({ id: "two", role: "assistant", content: "Main answer", modelKey: "thinking" }),
      message({ id: "sibling", threadId: "sibling", content: "Sibling secret" }),
      message({ id: "empty", threadId: "", content: "Not a main row" }),
    ];
    const before = structuredClone(rows);
    expect(assembleMainPrompt(rows)).toEqual([
      { role: "system", content: MAIN_SYSTEM_PROMPT },
      { role: "user", content: "  Main question\n" },
      { role: "assistant", content: "Main answer" },
    ]);
    expect(rows).toEqual(before);
  });

  it("labels every briefing field and orders full parent, subject, and matching thread history", () => {
    const branch = thread({ kind: "compressed", briefing });
    branch.anchorExact = "Selected passage\n".repeat(2_000);
    const parent = message({ id: "parent", role: "assistant", content: "Complete parent\n".repeat(4_000) });
    const question = message({ id: "question", threadId: branch.id, content: "Thread question\n".repeat(2_000) });
    const answer = message({ id: "answer", threadId: branch.id, role: "assistant", content: "Thread answer\n".repeat(2_000) });
    const result = assembleThreadPrompt(branch, parent, [
      message({ content: "A future main message must never leak" }),
      question,
      message({ threadId: "sibling", content: "Sibling must never leak" }),
      message({ chatId: "another-chat", threadId: branch.id, content: "Other chat must never leak" }),
      answer,
    ]);
    expect(result).toHaveLength(5);
    expect(result[0]).toEqual({ role: "system", content: `Frozen main conversation briefing:\n\n${renderBriefing(briefing)}` });
    for (const label of ["Goal:", "Constraints:", "Decisions:", "Artifacts:", "Open questions:"]) {
      expect(result[0].content).toContain(label);
    }
    for (const value of [briefing.goal, ...briefing.constraints, ...briefing.decisions, ...briefing.artifacts, ...briefing.open_questions]) {
      expect(result[0].content).toContain(value);
    }
    expect(result.slice(1)).toEqual([
      { role: "assistant", content: parent.content },
      { role: "system", content: `Thread subject:\n${branch.anchorExact}` },
      { role: "user", content: question.content },
      { role: "assistant", content: answer.content },
    ]);
  });

  it("encodes fallback messages in explicit role-labelled blocks without changing their contents", () => {
    const frozen: FrozenContext = {
      kind: "fallback",
      messages: [
        { role: "system", content: "Original instructions\n\n  untouched  " },
        { role: "user", content: "Question\n".repeat(2_000) },
        { role: "assistant", content: "```typescript\nconst value = 'verbatim';\n```\n" },
      ],
    };
    const branch = thread(frozen);
    const parent = message({ role: "assistant", content: "The entire parent" });
    const result = assembleThreadPrompt(branch, parent, []);
    expect(result[0].role).toBe("system");
    expect(result[0].content).toContain("Frozen main conversation context (verbatim fallback):");
    frozen.messages.forEach((item, index) => {
      expect(result[0].content).toContain(`--- Message ${index + 1} (${item.role}) ---\n${item.content}\n--- End message ${index + 1} ---`);
    });
    expect(result.slice(1)).toEqual([
      { role: "assistant", content: parent.content },
      { role: "system", content: "Thread subject:\nSubject" },
    ]);
    expect(assembleThreadPrompt(branch, parent, [])).toEqual(result);
  });

  it("handles a not-yet-frozen context without importing the main conversation", () => {
    const parent = message({ role: "assistant", content: "Parent" });
    expect(assembleThreadPrompt(thread(), parent, [message()])).toEqual([
      { role: "system", content: "Frozen main conversation briefing:\nNo briefing is available." },
      { role: "assistant", content: "Parent" },
      { role: "system", content: "Thread subject:\nSubject" },
    ]);
  });
});
