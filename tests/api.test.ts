import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertLocalRequest } from "../lib/api";
import { ChatRepository } from "../lib/db/repository";
import { GET as getChats, PATCH as patchChat, POST as createChat } from "../app/api/chats/route";
import { PATCH as patchFolder, POST as createFolder } from "../app/api/folders/route";
import { POST as restoreDemo } from "../app/api/demo/route";
import { GET as searchMessages } from "../app/api/search/route";
import { DEMO_FOLDERS } from "../lib/demo-catalog";
import { acquireGeneration } from "../lib/generation-lock";

describe("same-origin mutation protection", () => {
  it("uses the browser Host header when Next normalizes the internal URL to localhost", () => {
    const request = new Request("http://localhost:3000/api/chats", {
      method: "POST",
      headers: { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000", "sec-fetch-site": "same-origin" },
    });
    expect(() => assertLocalRequest(request)).not.toThrow();
  });

  it("rejects a foreign origin even with a same-origin claim", () => {
    const request = new Request("http://localhost:3000/api/chats", {
      method: "POST",
      headers: { host: "localhost:3000", origin: "https://example.org", "sec-fetch-site": "same-origin" },
    });
    expect(() => assertLocalRequest(request)).toThrow("This request must come from the app.");
  });

  it("rejects cross-site requests without an Origin header", () => {
    expect(() => assertLocalRequest(new Request("http://localhost:3000/api/chats", { headers: { "sec-fetch-site": "cross-site" } }))).toThrow();
  });

  it("accepts a same-origin loopback preview whose proxy rewrites the target port", () => {
    const request = new Request("http://localhost:3000/api/chats", {
      method: "POST",
      headers: { host: "127.0.0.1:3000", origin: "http://127.0.0.1:51816", "sec-fetch-site": "same-origin" },
    });
    expect(() => assertLocalRequest(request)).not.toThrow();
  });

  it.each(["same-site", "cross-site", "none", ""])("rejects a different local port when browser metadata is %s", (site) => {
    const request = new Request("http://localhost:3000/api/chats", {
      method: "POST",
      headers: { host: "127.0.0.1:3000", origin: "http://127.0.0.1:51816", "sec-fetch-site": site },
    });
    expect(() => assertLocalRequest(request)).toThrow("This request must come from the app.");
  });

  it.each(["null", "https://127.0.0.1:51816", "http://localhost.example.org:51816"])("rejects an untrusted preview origin %s", (origin) => {
    const request = new Request("http://localhost:3000/api/chats", {
      method: "POST",
      headers: { host: "127.0.0.1:3000", origin, "sec-fetch-site": "same-origin" },
    });
    expect(() => assertLocalRequest(request)).toThrow("This request must come from the app.");
  });

  it("allows local command-line requests without browser origin headers", () => {
    const request = new Request("http://localhost:3000/api/chats");
    expect(() => assertLocalRequest(request)).not.toThrow();
  });
});

describe("library mutations", () => {
  let repository: ChatRepository;

  beforeEach(() => {
    repository = new ChatRepository(":memory:");
    vi.stubGlobal("__threadsRepository", repository);
  });

  afterEach(() => {
    repository.close();
    vi.unstubAllGlobals();
  });

  function patch(resource: string, id: string, body: unknown) {
    return new Request(`http://localhost:3000/api/${resource}?id=${id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
  }

  it("restores demo summaries idempotently and loads only a selected conversation", async () => {
    const personal = repository.createChat();
    const request = () => new Request("http://localhost:3000/api/demo", { method: "POST", body: JSON.stringify({ action: "restore" }) });
    const restored = await restoreDemo(request());
    expect(restored.status).toBe(200);
    expect(await restored.json()).toEqual({ addedFolders: 4, addedChats: 27 });
    expect(await (await restoreDemo(request())).json()).toEqual({ addedFolders: 0, addedChats: 0 });
    const list = await (await getChats(new Request("http://localhost:3000/api/chats"))).json();
    expect(Object.keys(list).sort()).toEqual(["chats", "folders"]);
    expect(list.chats).toHaveLength(28);
    expect(repository.listChats().every((chat) => !repository.hasMessages(chat.id))).toBe(true);
    const id = DEMO_FOLDERS[0].chats[0].id;
    const selected = await (await getChats(new Request(`http://localhost:3000/api/chats?id=${id}`))).json();
    expect(selected.messages).toHaveLength(6);
    expect(selected.threads).toHaveLength(3);
    expect(selected.messages.every((message: { threadId: string | null }) => message.threadId === null)).toBe(true);
    expect(repository.listChats().filter((chat) => repository.hasMessages(chat.id)).map((chat) => chat.id)).toEqual([id]);
    expect(repository.getChat(personal.id)).toEqual(personal);
  });

  it("hydrates only the searched demo and leaves other conversation bodies unloaded", async () => {
    await restoreDemo(new Request("http://localhost:3000/api/demo", { method: "POST", body: JSON.stringify({ action: "restore" }) }));
    const id = DEMO_FOLDERS[0].chats[0].id;
    const response = await searchMessages(new Request(`http://localhost:3000/api/search?chatId=${id}&q=coefficients`));
    expect(response.status).toBe(200);
    expect((await response.json()).results.length).toBeGreaterThan(0);
    expect(repository.hasMessages(DEMO_FOLDERS[0].chats[1].id)).toBe(false);
  });

  it("rejects foreign, invalid, and busy demo restore requests without adding data", async () => {
    const foreign = await restoreDemo(new Request("http://localhost:3000/api/demo", {
      method: "POST", body: JSON.stringify({ action: "restore" }), headers: { origin: "https://example.org" },
    }));
    expect(foreign.status).toBe(403);
    const invalid = await restoreDemo(new Request("http://localhost:3000/api/demo", { method: "POST", body: JSON.stringify({ action: "reset" }) }));
    expect(invalid.status).toBe(400);
    const lease = acquireGeneration("restore-test");
    try {
      const busy = await restoreDemo(new Request("http://localhost:3000/api/demo", { method: "POST", body: JSON.stringify({ action: "restore" }) }));
      expect(busy.status).toBe(409);
    } finally { lease.release(); }
    expect(repository.listChats()).toEqual([]);
    expect(repository.listFolders()).toEqual([]);
  });

  it("persists a trimmed conversation name without unfiling it", async () => {
    const folder = repository.createFolder("Work");
    const chat = repository.moveChat(repository.createChat().id, folder.id);
    const response = await patchChat(patch("chats", chat.id, { title: "  Saved name  " }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ chat: { ...chat, title: "Saved name" } });
    expect(repository.getChat(chat.id)?.folderId).toBe(folder.id);
  });

  it.each([{}, null, { title: " " }, { title: 1 }, { title: "Name", folderId: null }])("rejects an invalid rename without moving the chat: %j", async (body) => {
    const folder = repository.createFolder("Work");
    const chat = repository.moveChat(repository.createChat().id, folder.id);
    const response = await patchChat(patch("chats", chat.id, body));
    expect(response.status).toBe(400);
    expect(repository.getChat(chat.id)).toEqual(chat);
  });

  it("returns 404 rather than a successful empty rename for a missing chat", async () => {
    const response = await patchChat(patch("chats", "missing", { title: "Name" }));
    expect(response.status).toBe(404);
  });

  it("renames a folder without changing its parent or contents", async () => {
    const parent = repository.createFolder("Parent");
    const folder = repository.createFolder("Old name", parent.id);
    const chat = repository.moveChat(repository.createChat().id, folder.id);
    const response = await patchFolder(patch("folders", folder.id, { name: "  New name  " }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ folder: { ...folder, name: "New name" } });
    expect(repository.getChat(chat.id)).toEqual(chat);
  });

  it("routes folder moves separately from renames and rejects cycles", async () => {
    const parent = repository.createFolder("Parent");
    const folder = repository.createFolder("Child");
    const moved = await patchFolder(patch("folders", folder.id, { parentId: parent.id }));
    expect(moved.status).toBe(200);
    expect(await moved.json()).toEqual({ folder: { ...folder, parentId: parent.id } });
    const cycle = await patchFolder(patch("folders", parent.id, { parentId: folder.id }));
    expect(cycle.status).toBe(400);
    const restored = await patchFolder(patch("folders", folder.id, { parentId: null }));
    expect(restored.status).toBe(200);
    expect(await restored.json()).toEqual({ folder });
  });

  it("creates named subfolders and conversations in the requested location", async () => {
    const parent = repository.createFolder("Work");
    const folderResponse = await createFolder(new Request("http://localhost:3000/api/folders", {
      method: "POST", body: JSON.stringify({ name: "  Reading  ", parentId: parent.id }),
    }));
    expect(folderResponse.status).toBe(201);
    const { folder } = await folderResponse.json();
    expect(folder).toMatchObject({ name: "Reading", parentId: parent.id });
    const chatResponse = await createChat(new Request("http://localhost:3000/api/chats", {
      method: "POST", body: JSON.stringify({ folderId: folder.id }),
    }));
    expect(chatResponse.status).toBe(201);
    const { chat } = await chatResponse.json();
    expect(repository.getChat(chat.id)).toMatchObject({ title: "New chat", folderId: folder.id });
  });

  it("still supports creating an unsorted chat with an empty POST body", async () => {
    const response = await createChat(new Request("http://localhost:3000/api/chats", { method: "POST" }));
    expect(response.status).toBe(201);
    expect((await response.json()).chat.folderId).toBeNull();
  });

  it("does not create a stray chat when the destination folder is missing", async () => {
    const response = await createChat(new Request("http://localhost:3000/api/chats", {
      method: "POST", body: JSON.stringify({ folderId: "missing" }),
    }));
    expect(response.status).toBe(404);
    expect(repository.listChats()).toEqual([]);
  });

  it("reports missing folder move targets instead of a successful empty update", async () => {
    const folder = repository.createFolder("Work");
    const missingFolder = await patchFolder(patch("folders", "missing", { parentId: null }));
    expect(missingFolder.status).toBe(404);
    const missingParent = await patchFolder(patch("folders", folder.id, { parentId: "missing" }));
    expect(missingParent.status).toBe(404);
    expect(repository.listFolders()).toEqual([folder]);
  });

  it("rejects unreadable rename requests and foreign-origin mutations", async () => {
    const chat = repository.createChat();
    const malformed = await patchChat(new Request(`http://localhost:3000/api/chats?id=${chat.id}`, { method: "PATCH", body: "{" }));
    expect(malformed.status).toBe(400);
    const foreign = await patchChat(new Request(`http://localhost:3000/api/chats?id=${chat.id}`, {
      method: "PATCH", body: JSON.stringify({ title: "Changed" }), headers: { origin: "https://example.org" },
    }));
    expect(foreign.status).toBe(403);
    expect(repository.getChat(chat.id)).toEqual(chat);
  });
});
