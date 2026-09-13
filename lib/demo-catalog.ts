export interface DemoFolder {
  id: string;
  name: string;
  chats: { id: string; title: string; createdAt: number }[];
}

export interface DemoDialogue {
  user: string;
  assistant: string;
}

export interface DemoThread {
  quote: string;
  title: string;
  resolved: boolean;
  exchanges: DemoDialogue[];
}

export interface DemoConversation {
  id: string;
  goal: string;
  sources: string[];
  exchanges: (DemoDialogue & { summary: string; threads: DemoThread[] })[];
}

function folder(key: string, name: string, entries: [string, string, string][]): DemoFolder {
  return {
    id: `demo-folder-${key}`, name,
    chats: entries.map(([id, title, date]) => ({ id: `demo-${id}`, title, createdAt: Date.parse(`${date}T17:00:00Z`) })),
  };
}

export const DEMO_SEED_KEY = "study-library-v1";

export const DEMO_FOLDERS: DemoFolder[] = [
  folder("linear-algebra", "Linear Algebra", [
    ["la-span", "01 · Span, independence, and what a basis buys you", "2026-08-26"],
    ["la-rank", "02 · Row reduction, null spaces, and solution sets", "2026-08-29"],
    ["la-maps", "03 · Linear maps and changing coordinates", "2026-09-02"],
    ["la-eigen", "04 · Eigenvectors, repeated roots, and diagonalization", "2026-09-05"],
    ["la-projections", "05 · Least squares, projections, and the SVD", "2026-09-09"],
  ]),
  folder("bernstein", "Local Bernstein theory, and lower bounds for Lebesgue constants — Terence Tao", [
    ["tao-overview", "01 · What the theorem actually says", "2026-09-03"],
    ["tao-global", "02 · Bernstein, Boas, and the extremal sinusoid", "2026-09-04"],
    ["tao-local", "03 · Local rectangles and the error budget", "2026-09-06"],
    ["tao-toy", "04 · The trigonometric toy model and sharp constants", "2026-09-08"],
    ["tao-scales", "05 · Root measures, three scales, and the proof map", "2026-09-10"],
    ["tao-frontier", "06 · Baire category, quantifiers, and what remains open", "2026-09-12"],
  ]),
  folder("psychology", "Psychology", [
    ["psych-frequency", "01 · Baader–Meinhof: why I suddenly see it everywhere", "2026-08-28"],
    ["psych-stockholm", "02 · Stockholm syndrome: evidence, labels, and survival", "2026-09-01"],
    ["psych-learning", "03 · Retrieval, spacing, and a study plan that tests itself", "2026-09-07"],
    ["psych-memory", "04 · Memory, confirmation bias, and reading studies critically", "2026-09-11"],
  ]),
  folder("cs61a", "CS61A", [
    ["cs-expressions", "01 · Expressions, evaluation order, and names", "2026-08-28"],
    ["cs-print", "02 · print, return, None: a WWPD survival kit", "2026-08-29"],
    ["cs-control", "03 · Truthiness, short-circuiting, and if", "2026-08-31"],
    ["cs-iteration", "04 · while loops, digit problems, and invariants", "2026-09-01"],
    ["cs-environments", "05 · Environment diagrams: frames, not vibes", "2026-09-02"],
    ["cs-hof", "06 · Higher-order functions and generalizing patterns", "2026-09-04"],
    ["cs-closures", "07 · Nested def, lexical scope, and closures", "2026-09-05"],
    ["cs-lambda", "08 · Lambdas, currying, and call chains", "2026-09-08"],
    ["cs-composition", "09 · Composition, repeat, and functional abstraction", "2026-09-09"],
    ["cs-debugging", "10 · Mixed tracing: side effects and sneaky errors", "2026-09-11"],
    ["cs-midterm", "11 · Midterm 1 rehearsal and my mistake log", "2026-09-12"],
    ["cs-search", "12 · Search, inverses, primes, and testing", "2026-09-12"],
  ]),
];

export function demoChat(id: string) {
  for (const folder of DEMO_FOLDERS) {
    const chat = folder.chats.find((chat) => chat.id === id);
    if (chat) return { folder, chat };
  }
  return null;
}
