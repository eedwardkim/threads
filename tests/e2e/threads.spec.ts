import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { api, BASE_URL, cookieHeader, createTestUser, sessionCookies, signInViaForm, streamGenerate, type TestUser } from "./support";

/**
 * Browser acceptance tests for the critical Threads flows against a production build with mock inference.
 * Every test creates its own disposable users, so tests run in parallel without sharing state.
 */

const LONG_PROMPT = "Design a local-first knowledge base on SQLite with an outbox and sync worker. Cover retries, durability, and search.";

async function newChatThroughUi(page: Page): Promise<string> {
  await page.getByRole("button", { name: "New chat" }).click();
  await expect(page.getByTestId("main-composer")).toBeVisible();
  await expect.poll(() => new URL(page.url()).searchParams.get("chat")).not.toBeNull();
  return new URL(page.url()).searchParams.get("chat")!;
}

async function sendAndAwaitReply(page: Page, text: string): Promise<void> {
  const composer = page.getByTestId("main-composer");
  await composer.fill(text);
  await page.getByRole("button", { name: "Send main message" }).click();
  const scroll = page.getByTestId("main-scroll");
  await expect(scroll.locator('[data-role="assistant"]').last()).toBeVisible();
  await expect(scroll.locator('[data-role="assistant"][data-complete="true"]').last()).toBeVisible({ timeout: 60_000 });
}

const FIND_PARAGRAPH = `
  const articles = document.querySelectorAll('[data-role="assistant"][data-complete="true"][data-scope="main"]');
  const article = articles[articles.length - 1];
  const paragraph = [...article.querySelectorAll("[data-markdown-root] p")].find((node) => (node.textContent ?? "").trim().length > 40);
  if (!paragraph) throw new Error("No selectable paragraph rendered.");
`;

async function selectPassageInLastAnswer(page: Page): Promise<string> {
  // Scroll first and let the scroll event settle: scrolling dismisses the selection toolbar.
  await page.evaluate(`(() => { ${FIND_PARAGRAPH} paragraph.scrollIntoView({ block: "center" }); })()`);
  await page.waitForTimeout(150);
  const quote: unknown = await page.evaluate(`(() => {
    ${FIND_PARAGRAPH}
    const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
    let textNode = null;
    while (walker.nextNode()) {
      const candidate = walker.currentNode;
      if ((candidate.textContent ?? "").trim().length > 30 && !candidate.parentElement?.closest("[data-anchor-marker], [data-md-ui], code")) { textNode = candidate; break; }
    }
    if (!textNode) throw new Error("No plain text node rendered.");
    const range = document.createRange();
    range.setStart(textNode, 2);
    range.setEnd(textNode, Math.min(textNode.length, 24));
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    return range.toString();
  })()`);
  if (typeof quote !== "string") throw new Error("Selection did not produce text.");
  return quote;
}

test.describe("authentication", () => {
  test("unauthenticated visitors are redirected to login, APIs answer with JSON 401, and login lands in Threads", async ({ page, request }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByRole("heading", { name: "Sign in to Threads" })).toBeVisible();

    const chats = await request.get("/api/chats");
    expect(chats.status()).toBe(401);
    expect(chats.headers()["content-type"]).toContain("application/json");
    expect(await chats.json()).toMatchObject({ code: "unauthorized" });
    expect(chats.headers()["cache-control"]).toContain("no-store");

    const user = await createTestUser("auth");
    await signInViaForm(page, user);
    await expect(page).toHaveURL(/\/(\?.*)?$/);
    await expect(page.getByRole("button", { name: "Browse library" })).toBeVisible();
    await expect(page.getByRole("heading", { name: /Conversations/ })).toBeVisible();
  });

  test("open redirects are refused and sign-up flows straight into the app", async ({ page }) => {
    await page.goto("/login?next=https://evil.example.com/");
    await page.getByRole("button", { name: "New here? Create an account" }).click();
    const email = `signup-${randomUUID()}@example.com`;
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(`pw-${randomUUID()}`);
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.getByRole("button", { name: "New chat" })).toBeVisible();
    expect(new URL(page.url()).origin).toBe(new URL(BASE_URL).origin);
  });

  test("sign-out clears the workspace and later private requests fail closed", async ({ page }) => {
    const user = await createTestUser("signout");
    await signInViaForm(page, user);
    const chatId = await newChatThroughUi(page);
    await sendAndAwaitReply(page, "hello there, quick check");
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/login/);
    const response = await page.request.get(`/api/chats?id=${chatId}`);
    expect(response.status()).toBe(401);
    await page.goto(`/?chat=${chatId}`);
    await expect(page).toHaveURL(/\/login\?next=/);
  });
});

test.describe("conversations", () => {
  test("a new chat streams a mock answer, auto-titles, persists across reload and a second session", async ({ page, browser }) => {
    const user = await createTestUser("persist");
    await signInViaForm(page, user);
    const chatId = await newChatThroughUi(page);
    await sendAndAwaitReply(page, "What is the difference between a mutex and a semaphore?");
    await expect(page.getByRole("heading", { level: 1 })).not.toContainText("A fresh page");
    const answer = await page.getByTestId("main-scroll").locator('[data-role="assistant"] .message-body').last().innerText();
    expect(answer.length).toBeGreaterThan(50);

    await page.reload();
    await expect(page.getByTestId("main-scroll").locator('[data-role="assistant"][data-complete="true"]')).toHaveCount(1);
    await expect(page.getByTestId("main-scroll").locator('[data-role="assistant"] .message-body').last()).toHaveText(answer);

    const other = await browser.newContext();
    const second = await other.newPage();
    await signInViaForm(second, user, `/?chat=${chatId}`);
    await expect(second.getByTestId("main-scroll").locator('[data-role="assistant"][data-complete="true"]')).toHaveCount(1);
    await other.close();
  });

  test("drafting continues while a response streams, Stop preserves an incomplete partial, and Retry recovers", async ({ page }) => {
    const user = await createTestUser("stop");
    await signInViaForm(page, user);
    await newChatThroughUi(page);
    const composer = page.getByTestId("main-composer");
    await composer.fill(LONG_PROMPT);
    await page.getByRole("button", { name: "Send main message" }).click();
    const stop = page.getByRole("button", { name: "Stop generation" });
    await expect(stop).toBeVisible();
    await expect(page.getByTestId("main-scroll").locator('[data-role="assistant"]').last()).toBeVisible();

    await composer.fill("a draft typed while streaming");
    await expect(composer).toBeFocused();
    await expect(composer).toHaveValue("a draft typed while streaming");

    await stop.click();
    await expect(stop).toBeHidden();
    const partial = page.getByTestId("main-scroll").locator('[data-role="assistant"]').last();
    await expect(partial).toHaveAttribute("data-complete", "false");
    await expect(composer).toHaveValue("a draft typed while streaming");

    await page.reload();
    const reloaded = page.getByTestId("main-scroll").locator('[data-role="assistant"]').last();
    await expect(reloaded).toHaveAttribute("data-complete", "false");
    await page.getByRole("button", { name: /^Retry/ }).click();
    await expect(page.getByTestId("main-scroll").locator('[data-role="assistant"][data-complete="true"]')).toHaveCount(1, { timeout: 60_000 });
    await expect(page.getByTestId("main-scroll").locator('[data-role="assistant"]')).toHaveCount(1);
  });

  test("selecting a passage opens a thread whose anchor and answers survive reload; copy to main snapshots the reply", async ({ page }) => {
    const user = await createTestUser("thread");
    await signInViaForm(page, user);
    const chatId = await newChatThroughUi(page);
    await sendAndAwaitReply(page, LONG_PROMPT);
    const quote = await selectPassageInLastAnswer(page);
    await page.getByRole("button", { name: "Reply to selected passage" }).click();
    const panel = page.getByTestId("thread-panel");
    await expect(panel).toBeVisible();
    await expect(panel.getByTestId("thread-composer")).toBeVisible();

    await panel.getByTestId("thread-composer").fill("Explain this passage in one paragraph.");
    await panel.getByRole("button", { name: "Send thread message" }).click();
    await expect(panel.locator('[data-role="assistant"][data-complete="true"]')).toHaveCount(1, { timeout: 60_000 });
    await expect(page.getByTestId("main-scroll").locator('[data-role="assistant"]')).toHaveCount(1);

    const cookies = cookieHeader((await page.context().cookies()).map((cookie) => ({ name: cookie.name, value: cookie.value })));
    const chat = await api<{ messages: { id: string; content: string }[]; threads: { id: string; anchorStart: number; anchorEnd: number; parentMessageId: string }[] }>({ cookies, path: `/api/chats?id=${chatId}` });
    expect(chat.status).toBe(200);
    expect(chat.json.threads).toHaveLength(1);
    const thread = chat.json.threads[0];
    const parent = chat.json.messages.find((message) => message.id === thread.parentMessageId)!;
    expect(parent.content.slice(thread.anchorStart, thread.anchorEnd)).toBe(quote);

    await panel.locator('[data-role="assistant"]').last().getByRole("button", { name: "Copy to main chat" }).click();
    await expect(page.getByTestId("main-scroll").locator('[data-role="assistant"]')).toHaveCount(2);

    await page.reload();
    await expect(page.getByTestId("main-scroll").locator('[data-role="assistant"]')).toHaveCount(2);
    await page.locator(`[data-anchor-marker="${thread.id}"]`).first().click();
    await expect(page.getByTestId("thread-panel").locator('[data-role="assistant"][data-complete="true"]')).toHaveCount(1);
  });

  test("folders can be created and renamed; search finds messages; deleting a folder keeps its chats", async ({ page }) => {
    const user = await createTestUser("folders");
    await signInViaForm(page, user);
    const chatId = await newChatThroughUi(page);
    await sendAndAwaitReply(page, "Remind me about eigenvalues and determinants please.");

    await page.getByRole("button", { name: "New folder" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("textbox").fill("Zeta review");
    await dialog.getByRole("button", { name: /Save name|Create/ }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText("Zeta review")).toBeVisible();

    const cookies = cookieHeader((await page.context().cookies()).map((cookie) => ({ name: cookie.name, value: cookie.value })));
    const library = await api<{ folders: { id: string; name: string }[] }>({ cookies, path: "/api/chats" });
    const folder = library.json.folders.find((item) => item.name === "Zeta review")!;
    expect(folder).toBeTruthy();
    expect((await api({ cookies, method: "PATCH", path: `/api/chats?id=${chatId}`, body: { folderId: folder.id } })).status).toBe(200);
    expect((await api({ cookies, method: "PATCH", path: `/api/folders?id=${folder.id}`, body: { name: "Zeta review II" } })).status).toBe(200);
    await page.reload();
    await expect(page.getByText("Zeta review II")).toBeVisible();

    await page.getByRole("button", { name: "Search conversation" }).click();
    await page.getByLabel("Search messages").fill("eigenvalues");
    await expect(page.locator("[data-search-message]").first()).toBeVisible();
    await expect(page.locator("[data-search-message]").first()).toContainText(/eigenvalues/i);

    expect((await api({ cookies, method: "DELETE", path: `/api/folders?id=${folder.id}` })).status).toBe(200);
    const after = await api<{ chats: { id: string; folderId: string | null }[] }>({ cookies, path: "/api/chats" });
    expect(after.json.chats.find((chat) => chat.id === chatId)?.folderId ?? null).toBeNull();
  });

  test("demo conversations are lazily hydrated per user and restore only what is missing", async ({ page }) => {
    const user = await createTestUser("demo");
    await signInViaForm(page, user);
    const cookies = cookieHeader((await page.context().cookies()).map((cookie) => ({ name: cookie.name, value: cookie.value })));
    const library = await api<{ chats: { id: string; demoKey: string | null; title: string }[] }>({ cookies, path: "/api/chats" });
    const demos = library.json.chats.filter((chat) => chat.demoKey);
    expect(demos.length).toBeGreaterThan(0);
    const demo = demos[0];

    await page.goto(`/?chat=${demo.id}`);
    await expect(page.getByText("Study demo")).toBeVisible();
    await expect(page.getByTestId("main-scroll").locator('[data-role="assistant"]').first()).toBeVisible();
    await expect(page.getByText("Prewritten").first()).toBeVisible();

    expect((await api({ cookies, method: "PATCH", path: `/api/chats?id=${demo.id}`, body: { title: "My renamed demo" } })).status).toBe(200);
    expect((await api({ cookies, method: "DELETE", path: `/api/chats?id=${demos[1]?.id ?? demo.id}` })).status).toBe(200);
    const restore = await api({ cookies, method: "POST", path: "/api/demo", body: { action: "restore" } });
    expect(restore.status).toBe(200);
    const after = await api<{ chats: { id: string; demoKey: string | null; title: string }[] }>({ cookies, path: "/api/chats" });
    expect(after.json.chats.filter((chat) => chat.demoKey).length).toBe(demos.length);
    if (demos.length > 1) expect(after.json.chats.find((chat) => chat.id === demo.id)?.title).toBe("My renamed demo");
  });
});

test.describe("isolation and concurrency", () => {
  let alice: TestUser;
  let bob: TestUser;
  test.beforeAll(async () => {
    [alice, bob] = await Promise.all([createTestUser("alice"), createTestUser("bob")]);
  });

  test("two users cannot read, mutate, search, copy, or stop each other's work", async () => {
    const a = cookieHeader(await sessionCookies(alice));
    const b = cookieHeader(await sessionCookies(bob));
    const created = await api<{ chat: { id: string } }>({ cookies: a, method: "POST", path: "/api/chats", body: {} });
    expect(created.status).toBe(201);
    const chatId = created.json.chat.id;
    const run = await streamGenerate({ cookies: a, body: { chatId, threadId: null, content: "hello from alice, quick check", modelKey: "fast" } });
    expect(run.finish).toBeTruthy();
    const messageId = run.messageId!;

    expect((await api({ cookies: b, path: `/api/chats?id=${chatId}` })).status).toBe(404);
    expect((await api({ cookies: b, method: "PATCH", path: `/api/chats?id=${chatId}`, body: { title: "hijacked" } })).status).toBe(404);
    expect([200, 404]).toContain((await api({ cookies: b, method: "DELETE", path: `/api/chats?id=${chatId}` })).status);
    expect((await api({ cookies: b, path: `/api/search?chatId=${chatId}&q=hello` })).status).toBe(404);
    expect((await api({ cookies: b, method: "POST", path: "/api/threads", body: { parentMessageId: messageId, anchorStart: 0, anchorEnd: 5 } })).status).toBe(404);
    expect((await api({ cookies: b, method: "POST", path: "/api/messages", body: { action: "copy-to-main", messageId } })).status).toBe(404);
    const foreignStop = await api<{ stopped: boolean }>({ cookies: b, method: "DELETE", path: `/api/generate?id=${run.requestId}` });
    expect(foreignStop.status).toBe(200);
    expect(foreignStop.json.stopped).toBe(false);
    const bobLibrary = await api<{ chats: { id: string }[] }>({ cookies: b, path: "/api/chats" });
    expect(bobLibrary.json.chats.some((chat) => chat.id === chatId)).toBe(false);
    const stillThere = await api<{ chat: { title: string } }>({ cookies: a, path: `/api/chats?id=${chatId}` });
    expect(stillThere.status).toBe(200);
    expect(stillThere.json.chat.title).not.toBe("hijacked");
  });

  test("opening another user's chat URL shows a not-found notice and drops the foreign id", async ({ page }) => {
    const a = cookieHeader(await sessionCookies(alice));
    const created = await api<{ chat: { id: string } }>({ cookies: a, method: "POST", path: "/api/chats", body: {} });
    const chatId = created.json.chat.id;
    await signInViaForm(page, bob, `/?chat=${chatId}`);
    await expect(page.getByText("That conversation no longer exists.")).toBeVisible();
    await expect.poll(() => new URL(page.url()).searchParams.get("chat")).not.toBe(chatId);
  });

  test("a duplicate request id is idempotent, a changed payload is rejected, and unrelated scopes stream concurrently", async () => {
    const a = cookieHeader(await sessionCookies(alice));
    const b = cookieHeader(await sessionCookies(bob));
    const [chatA, chatB] = await Promise.all([
      api<{ chat: { id: string } }>({ cookies: a, method: "POST", path: "/api/chats", body: {} }),
      api<{ chat: { id: string } }>({ cookies: b, method: "POST", path: "/api/chats", body: {} }),
    ]);
    const requestId = randomUUID();
    const body = { requestId, chatId: chatA.json.chat.id, threadId: null, content: LONG_PROMPT, modelKey: "fast" };
    const firstTexts: string[] = [];
    const [first, duplicate, other] = await Promise.all([
      streamGenerate({ cookies: a, body, onFirstText: () => firstTexts.push("a") }),
      new Promise<{ status: number }>((resolve) => setTimeout(() => resolve(api({ cookies: a, method: "POST", path: "/api/generate", body })), 150)),
      streamGenerate({ cookies: b, body: { chatId: chatB.json.chat.id, threadId: null, content: LONG_PROMPT, modelKey: "fast" }, onFirstText: () => firstTexts.push("b") }),
    ]);
    expect(first.finish).toBeTruthy();
    expect(other.finish).toBeTruthy();
    expect(duplicate.status).toBe(409);
    expect(firstTexts.sort()).toEqual(["a", "b"]);
    const mismatch = await api({ cookies: a, method: "POST", path: "/api/generate", body: { ...body, content: "something else" } });
    expect(mismatch.status).toBe(409);
    const chat = await api<{ messages: { role: string }[] }>({ cookies: a, path: `/api/chats?id=${chatA.json.chat.id}` });
    expect(chat.json.messages.filter((message) => message.role === "assistant")).toHaveLength(1);
  });

  test("a stop issued from another client is honoured and leaves an incomplete, retryable message", async () => {
    const a = cookieHeader(await sessionCookies(alice));
    const chat = await api<{ chat: { id: string } }>({ cookies: a, method: "POST", path: "/api/chats", body: {} });
    const requestId = randomUUID();
    let stoppedAt = 0;
    const stream = streamGenerate({
      cookies: a,
      body: { requestId, chatId: chat.json.chat.id, threadId: null, content: LONG_PROMPT, modelKey: "fast" },
      onFirstText: () => {
        void api({ cookies: a, method: "DELETE", path: `/api/generate?id=${requestId}` }).then(() => { stoppedAt = performance.now(); });
      },
    });
    const result = await stream;
    expect(result.finish).toMatchObject({ message: { complete: false } });
    expect(stoppedAt).toBeGreaterThan(0);
    expect(result.finishAt! - (result.firstTextAt ?? 0)).toBeLessThan(5_000);
    const job = await api<{ job: { status: string } }>({ cookies: a, path: `/api/generate?id=${requestId}` });
    expect(job.json.job.status).toBe("stopped");
  });
});

test.describe("mobile", () => {
  test("the workspace is usable on a phone: navigation drawer, composer, and streaming @mobile", async ({ page }) => {
    const user = await createTestUser("mobile");
    await signInViaForm(page, user);
    await page.getByRole("button", { name: "Open navigation" }).click();
    await page.getByRole("button", { name: "New chat" }).click();
    await expect(page.getByTestId("main-composer")).toBeVisible();
    await sendAndAwaitReply(page, "hello from a phone");
    await expect(page.getByTestId("main-scroll").locator('[data-role="assistant"][data-complete="true"]')).toHaveCount(1);
  });
});
