import { randomUUID } from "node:crypto";
import { cpus, platform, release, totalmem } from "node:os";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "@playwright/test";
import {
  api,
  BASE_URL,
  cookieHeader,
  createTestUser,
  sessionCookies,
  signInViaForm,
  streamGenerate,
  type StreamTiming,
  type TestUser,
} from "../tests/e2e/support";

/**
 * Deterministic performance harness (mock inference only; never paid models).
 *
 *   npm run perf                                   # against a production build on http://127.0.0.1:3100
 *   E2E_BASE_URL=https://<preview>.vercel.app npm run perf
 *   PERF_SECOND_BASE_URL=http://127.0.0.1:3101 npm run perf   # second instance sharing the same DB → true cross-instance Stop
 *   PERF_LATENCY_MS=80 npm run perf                # add symmetric network latency to the browser sessions (CDP emulation)
 *
 * Workload: 20 authenticated sessions (20 disposable users), 10 simultaneous mock streams in independent scopes while the
 * other 10 sessions navigate and mutate, long math-heavy answers, cross-instance Stop, plus browser-side measurements of
 * UI feedback, cached/uncached navigation and first DISPLAYED text. Writes perf-results/<timestamp>.json and prints a table.
 */

const SESSIONS = Number(process.env.PERF_SESSIONS ?? 20);
const STREAMS = Number(process.env.PERF_STREAMS ?? 10);
const SECOND_BASE_URL = process.env.PERF_SECOND_BASE_URL;
const LATENCY_MS = Number(process.env.PERF_LATENCY_MS ?? 0);
const MATH_PROMPT = "Prove that the determinant of a diagonalizable matrix equals the product of its eigenvalues, and show the trace identity for powers.";
const LONG_PROMPT = "Design a local-first knowledge base with an outbox, a sync worker and offline edits; be thorough about the recovery story.";

const samples = new Map<string, number[]>();
function record(name: string, value: number | null | undefined): void {
  if (value === null || value === undefined || !Number.isFinite(value)) return;
  const list = samples.get(name) ?? [];
  list.push(value);
  samples.set(name, list);
}
function percentile(values: number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}
function summary(): Record<string, { n: number; p50: number; p95: number; max: number }> {
  const out: Record<string, { n: number; p50: number; p95: number; max: number }> = {};
  for (const [name, values] of samples) {
    out[name] = { n: values.length, p50: round(percentile(values, 50)), p95: round(percentile(values, 95)), max: round(Math.max(...values)) };
  }
  return out;
}
const round = (n: number) => Math.round(n * 10) / 10;

interface Session { user: TestUser; cookies: string; chatId: string }

async function timed<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const started = performance.now();
  const result = await fn();
  record(name, performance.now() - started);
  return result;
}

async function ensureServer(base: string): Promise<void> {
  const response = await fetch(`${base}/login`, { redirect: "manual" });
  if (response.status >= 500) throw new Error(`${base} is not healthy (${response.status}).`);
}

async function createSession(index: number): Promise<Session> {
  const user = await createTestUser(`perf${index}`);
  const cookies = cookieHeader(await timed("auth.session_cookies_ms", () => sessionCookies(user)));
  const created = await timed("api.warm.create_chat_ms", () => api<{ chat: { id: string } }>({ cookies, method: "POST", path: "/api/chats", body: {} }));
  if (created.status !== 201) throw new Error(`create chat failed: ${created.status}`);
  return { user, cookies, chatId: created.json.chat.id };
}

function recordStream(prefix: string, timing: StreamTiming): void {
  record(`${prefix}.headers_ms`, timing.headersAt);
  record(`${prefix}.server_auth_ms`, timing.serverTiming.auth);
  record(`${prefix}.server_db_admission_ms`, timing.serverTiming.db);
  record(`${prefix}.provider_dispatch_ms`, timing.startAt);
  if (timing.startAt !== null && timing.firstTextAt !== null) record(`${prefix}.provider_first_token_ms`, timing.firstTextAt - timing.startAt);
  record(`${prefix}.client_first_text_ms`, timing.firstTextAt);
  record(`${prefix}.max_delta_gap_ms`, timing.firstTextAt === null ? null : timing.maxGapMs);
  if (timing.finishAt !== null && timing.lastTextAt !== null) record(`${prefix}.final_save_ms`, timing.finishAt - timing.lastTextAt);
  record(`${prefix}.total_ms`, timing.finishAt);
}

async function warmApiRound(session: Session): Promise<void> {
  const chats = await timed("api.warm.library_ms", () => api<{ chats: { id: string }[] }>({ cookies: session.cookies, path: "/api/chats" }));
  if (chats.status !== 200) throw new Error(`library ${chats.status}`);
  const chat = await timed("api.warm.chat_read_ms", () => api({ cookies: session.cookies, path: `/api/chats?id=${session.chatId}` }));
  if (chat.status !== 200) throw new Error(`chat read ${chat.status}`);
  const renamed = await timed("api.warm.rename_ms", () => api({ cookies: session.cookies, method: "PATCH", path: `/api/chats?id=${session.chatId}`, body: { title: `Perf ${randomUUID().slice(0, 6)}` } }));
  if (renamed.status !== 200) throw new Error(`rename ${renamed.status}`);
  const folder = await timed("api.warm.create_folder_ms", () => api<{ folder: { id: string } }>({ cookies: session.cookies, method: "POST", path: "/api/folders", body: { name: `Folder ${randomUUID().slice(0, 4)}` } }));
  if (folder.status !== 201 && folder.status !== 200) throw new Error(`folder ${folder.status}`);
  const search = await timed("api.warm.search_ms", () => api({ cookies: session.cookies, path: `/api/search?chatId=${session.chatId}&q=eigen` }));
  if (search.status !== 200) throw new Error(`search ${search.status}`);
}

interface Invariants { duplicateMessages: number; runningJobsAfter: number; crossUserLeaks: number; falseSaves: number; failedStreams: number }

async function streamsAndMutations(sessions: Session[]): Promise<Invariants> {
  const streamers = sessions.slice(0, STREAMS);
  const browsers = sessions.slice(STREAMS);
  const invariants: Invariants = { duplicateMessages: 0, runningJobsAfter: 0, crossUserLeaks: 0, falseSaves: 0, failedStreams: 0 };

  const streamWork = streamers.map(async (session, index) => {
    const prompt = index % 2 === 0 ? MATH_PROMPT : LONG_PROMPT;
    const timing = await streamGenerate({ cookies: session.cookies, body: { chatId: session.chatId, threadId: null, content: prompt, modelKey: "fast" } });
    if (timing.status !== 200 || !timing.finish || timing.error) { invariants.failedStreams += 1; return; }
    recordStream("stream.concurrent", timing);
    const finish = timing.finish as { message?: { complete?: boolean; content?: string } };
    // A "finish" must only follow a committed row with the same text (math normalization may rewrite delimiters, never words).
    const stored = await api<{ messages: { id: string; role: string; content: string; complete: boolean }[] }>({ cookies: session.cookies, path: `/api/chats?id=${session.chatId}` });
    const assistant = stored.json.messages.filter((m) => m.role === "assistant");
    if (assistant.length !== 1) invariants.duplicateMessages += Math.max(0, assistant.length - 1);
    const saved = assistant[0];
    if (!saved || !saved.complete || finish.message?.complete !== true || saved.content.replace(/\W/g, "") !== timing.text.replace(/\W/g, "")) invariants.falseSaves += 1;
  });

  const mutationWork = browsers.map(async (session) => {
    for (let round = 0; round < 3; round += 1) await warmApiRound(session);
  });

  await Promise.all([...streamWork, ...mutationWork]);

  // Nobody may see anyone else's chat; no scope may remain busy.
  for (const [index, session] of sessions.entries()) {
    const other = sessions[(index + 1) % sessions.length];
    const leak = await api({ cookies: session.cookies, path: `/api/chats?id=${other.chatId}` });
    if (leak.status !== 404) invariants.crossUserLeaks += 1;
    const running = await api<{ jobs: unknown[] }>({ cookies: session.cookies, path: "/api/generate" });
    invariants.runningJobsAfter += running.json.jobs.length;
  }
  return invariants;
}

async function duplicateRequest(session: Session): Promise<{ duplicated: boolean }> {
  const requestId = randomUUID();
  const body = { requestId, chatId: session.chatId, threadId: null, content: "Quick duplicate check for eigenvalues", modelKey: "fast" };
  const [first, second] = await Promise.all([
    streamGenerate({ cookies: session.cookies, body }),
    streamGenerate({ cookies: session.cookies, body }),
  ]);
  const before = (await api<{ messages: { role: string }[] }>({ cookies: session.cookies, path: `/api/chats?id=${session.chatId}` })).json.messages;
  const successes = [first, second].filter((t) => t.status === 200).length;
  return { duplicated: successes !== 1 || before.filter((m) => m.role === "user").length !== 2 };
}

async function crossInstanceStop(session: Session): Promise<{ propagationMs: number | null; incomplete: boolean; instance: "second" | "same" }> {
  const stopBase = SECOND_BASE_URL ?? BASE_URL;
  const requestId = randomUUID();
  let firstText: (() => void) | undefined;
  const gotText = new Promise<void>((resolveText) => { firstText = resolveText; });
  const run = streamGenerate({ cookies: session.cookies, body: { requestId, chatId: session.chatId, threadId: null, content: LONG_PROMPT, modelKey: "fast" }, onFirstText: () => firstText?.() });
  await gotText;
  const stopRequested = performance.now();
  const stop = await api<{ stopped: boolean }>({ baseUrl: stopBase, cookies: session.cookies, method: "DELETE", path: `/api/generate?id=${requestId}` });
  const timing = await run;
  const propagationMs = stop.status === 200 && stop.json.stopped ? performance.now() - stopRequested : null;
  record("stop.cross_instance_propagation_ms", propagationMs);
  const finish = timing.finish as { message?: { complete?: boolean } } | null;
  return { propagationMs, incomplete: finish?.message?.complete === false, instance: SECOND_BASE_URL ? "second" : "same" };
}

// ---------- browser measurements ----------

async function withLatency(context: BrowserContext, page: Page): Promise<void> {
  if (!LATENCY_MS) return;
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: LATENCY_MS, downloadThroughput: -1, uploadThroughput: -1 });
}

async function installEventTiming(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const durations: number[] = [];
    (window as unknown as { __eventDurations: number[] }).__eventDurations = durations;
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const event = entry as PerformanceEntry & { name: string; processingEnd: number };
          if (event.name === "keydown" || event.name === "click" || event.name === "input") durations.push(event.duration);
        }
      }).observe({ type: "event", buffered: true, durationThreshold: 0 } as PerformanceObserverInit);
    } catch { /* Event Timing unsupported */ }
  });
}

async function browserRound(browser: Browser, session: Session, chatIds: string[]): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, baseURL: BASE_URL });
  const page = await context.newPage();
  await installEventTiming(page);
  await withLatency(context, page);

  // Uncached navigation: shell vs content-ready, measured from navigation start inside the page.
  await signInViaForm(page, session.user, `/?chat=${chatIds[0]}`);
  record("browser.uncached.shell_visible_ms", await page.evaluate(() => performance.now()));
  await page.locator('[data-testid="main-scroll"] [data-message-id]').first().waitFor({ state: "visible" });
  record("browser.uncached.content_ready_ms", await page.evaluate(() => performance.now()));

  // Local UI feedback: typing into the composer (Event Timing duration = input → next paint).
  const composer = page.getByTestId("main-composer");
  await composer.click();
  await page.keyboard.type("Typing latency probe: the quick brown fox jumps over the lazy dog ", { delay: 5 });
  await page.waitForTimeout(300);
  for (const duration of await page.evaluate(() => (window as unknown as { __eventDurations: number[] }).__eventDurations.splice(0))) record("browser.ui_feedback_event_ms", duration);
  await composer.fill("");

  // Cached navigation: visit chats via the sidebar, then return; the repeat visits must render from the client cache.
  // Titles are used as the visible handle; give each chat a unique, known title first.
  for (const [index, id] of chatIds.entries()) await api({ cookies: session.cookies, method: "PATCH", path: `/api/chats?id=${id}`, body: { title: `perfnav-${index}-${id.slice(0, 6)}` } });
  await page.reload();
  await page.locator('[data-testid="main-scroll"] [data-message-id]').first().waitFor();
  const titleOf = (index: number, id: string) => `perfnav-${index}-${id.slice(0, 6)}`;
  const clickByTitle = async (title: string, name: string) => {
    const ms = await page.evaluate(async (t) => {
      const link = [...document.querySelectorAll<HTMLButtonElement>("button.chat-link")].find((button) => button.title === t);
      if (!link) throw new Error(`chat link ${t} not rendered`);
      const started = performance.now();
      link.click();
      // Poll per animation frame (no named inner functions: tsx's keepNames would inject __name into page code).
      for (;;) {
        await new Promise((frame) => requestAnimationFrame(frame));
        const heading = document.querySelector("h1 .editable-title span")?.textContent;
        if (heading === t && document.querySelector('[data-testid="main-scroll"] [data-message-id]')) break;
      }
      return performance.now() - started;
    }, title);
    record(name, ms);
  };
  await clickByTitle(titleOf(1, chatIds[1]), "browser.nav.first_visit_ms");
  await clickByTitle(titleOf(0, chatIds[0]), "browser.nav.cached_ms");
  await clickByTitle(titleOf(1, chatIds[1]), "browser.nav.cached_ms");
  await clickByTitle(titleOf(0, chatIds[0]), "browser.nav.cached_ms");

  // First DISPLAYED text: from clicking Send until an assistant bubble shows non-empty body text; then completion.
  await composer.fill(MATH_PROMPT);
  const displayed = await page.evaluate(async () => {
    const button = document.querySelector<HTMLButtonElement>('button[aria-label="Send main message"]');
    if (!button) throw new Error("send button missing");
    const before = document.querySelectorAll('[data-testid="main-scroll"] [data-role="assistant"]').length;
    const started = performance.now();
    button.click();
    let firstText = 0;
    for (;;) {
      await new Promise((frame) => requestAnimationFrame(frame));
      const bubbles = document.querySelectorAll('[data-testid="main-scroll"] [data-role="assistant"]');
      const last = bubbles[bubbles.length - 1];
      if (bubbles.length > before && (last?.querySelector(".message-body")?.textContent ?? "").trim().length > 0) { firstText = performance.now() - started; break; }
    }
    let complete = 0;
    for (;;) {
      await new Promise((frame) => requestAnimationFrame(frame));
      if (document.querySelectorAll('[data-testid="main-scroll"] [data-role="assistant"][data-complete="true"]').length > before) { complete = performance.now() - started; break; }
    }
    return { firstText, complete };
  });
  record("browser.first_displayed_text_ms", displayed.firstText);
  record("browser.answer_complete_ms", displayed.complete);
  await context.close();
}

async function main(): Promise<void> {
  const startedAt = new Date();
  await ensureServer(BASE_URL);
  if (SECOND_BASE_URL) await ensureServer(SECOND_BASE_URL);

  console.log(`Creating ${SESSIONS} sessions against ${BASE_URL} …`);
  const sessions: Session[] = [];
  for (let i = 0; i < SESSIONS; i += 1) sessions.push(await createSession(i));

  // Seed a long math-heavy conversation for the browser user (5 exchanges) so navigation/render measurements are representative.
  const browserSession = sessions[SESSIONS - 1];
  const navChats = [browserSession.chatId, (await api<{ chat: { id: string } }>({ cookies: browserSession.cookies, method: "POST", path: "/api/chats", body: {} })).json.chat.id];
  for (let i = 0; i < 4; i += 1) {
    const timing = await streamGenerate({ cookies: browserSession.cookies, body: { chatId: navChats[0], threadId: null, content: i % 2 ? LONG_PROMPT : MATH_PROMPT, modelKey: "fast" } });
    recordStream("stream.sequential_seed", timing);
  }
  recordStream("stream.sequential_seed", await streamGenerate({ cookies: browserSession.cookies, body: { chatId: navChats[1], threadId: null, content: MATH_PROMPT, modelKey: "fast" } }));

  console.log("Warm non-model API round (all sessions, concurrently) …");
  await Promise.all(sessions.map((session) => warmApiRound(session)));

  console.log(`${STREAMS} concurrent streams + ${SESSIONS - STREAMS} sessions mutating …`);
  const invariants = await streamsAndMutations(sessions);

  console.log("Duplicate-request and cross-instance Stop checks …");
  const duplicate = await duplicateRequest(sessions[1]);
  const stops = [];
  for (const session of sessions.slice(2, 5)) stops.push(await crossInstanceStop(session));

  console.log("Browser measurements …");
  const browser = await chromium.launch();
  try {
    for (let i = 0; i < 3; i += 1) await browserRound(browser, browserSession, navChats);
  } finally {
    await browser.close();
  }

  const report = {
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    environment: {
      baseUrl: BASE_URL,
      hosted: Boolean(process.env.E2E_BASE_URL),
      secondInstance: SECOND_BASE_URL ?? null,
      browserLatencyMs: LATENCY_MS,
      browser: "Playwright Chromium (headless), colocated with the harness — not a worldwide sample",
      harnessHost: { platform: platform(), release: release(), cpus: cpus().length, cpuModel: cpus()[0]?.model, memoryGb: round(totalmem() / 2 ** 30), node: process.version },
      inference: "mock (USE_MOCK=true; deterministic 18 ms chunk cadence, no paid models)",
      dataset: `${SESSIONS} users × 1–2 chats; browser user has a 5-exchange math-heavy chat (~4 KB per answer)`,
    },
    workload: { sessions: SESSIONS, concurrentStreams: STREAMS, mutatingSessions: SESSIONS - STREAMS, browserRounds: 3 },
    invariants: { ...invariants, duplicateRequestDuplicated: duplicate.duplicated, stops },
    latencies: summary(),
  };

  mkdirSync(resolve("perf-results"), { recursive: true });
  const file = resolve("perf-results", `${startedAt.toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, JSON.stringify(report, null, 2));

  console.log(`\n${"metric".padEnd(44)} ${"n".padStart(4)} ${"p50".padStart(9)} ${"p95".padStart(9)} ${"max".padStart(9)}`);
  for (const [name, stat] of Object.entries(report.latencies)) {
    console.log(`${name.padEnd(44)} ${String(stat.n).padStart(4)} ${String(stat.p50).padStart(9)} ${String(stat.p95).padStart(9)} ${String(stat.max).padStart(9)}`);
  }
  console.log("\ninvariants:", JSON.stringify(report.invariants));
  console.log(`\nreport: ${file}`);

  const failures: string[] = [];
  const l = report.latencies;
  if (invariants.duplicateMessages || invariants.crossUserLeaks || invariants.falseSaves || invariants.runningJobsAfter || invariants.failedStreams) failures.push("invariants violated");
  if (duplicate.duplicated) failures.push("duplicate request produced duplicate work");
  if (stops.some((s) => s.propagationMs === null || !s.incomplete || s.propagationMs > 2000)) failures.push("stop propagation > 2 s or partial not preserved");
  if (l["browser.ui_feedback_event_ms"]?.p95 > 100) failures.push("UI feedback p95 > 100 ms");
  if (l["browser.nav.cached_ms"]?.p95 > 100) failures.push("cached navigation p95 > 100 ms");
  for (const key of Object.keys(l).filter((k) => k.startsWith("api.warm."))) if (l[key].p95 > 500) failures.push(`${key} p95 > 500 ms`);
  if (l["browser.first_displayed_text_ms"]?.p95 > 1000) failures.push("first displayed text p95 > 1 s");
  if (l["stream.concurrent.max_delta_gap_ms"]?.p95 > 1000) failures.push("checkpoint-induced stall suspected (delta gap p95 > 1 s)");
  if (failures.length) {
    console.error(`\nTARGETS MISSED: ${failures.join("; ")}`);
    process.exitCode = 1;
  } else {
    console.log("\nAll documented targets met for this environment.");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
