import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { GET as getChat } from "../../app/api/chats/route";
import { POST as demoAction } from "../../app/api/demo/route";
import { GET as search } from "../../app/api/search/route";
import { setAuthResolverForTests } from "../../lib/auth/server";
import { setDatabaseForTests } from "../../lib/db/client";
import { seedDatabase } from "../../lib/seed";
import { newUser, testDatabase } from "./harness";

beforeAll(() => setDatabaseForTests(testDatabase()));
afterAll(() => setDatabaseForTests(undefined));
afterEach(() => setAuthResolverForTests(undefined));

describe("developer demo library", () => {
  it("hides old seeded rows, promotes personal children, and never hydrates a hidden URL", async () => {
    const { userId, repository } = newUser();
    setAuthResolverForTests(async () => ({ id: userId, email: null }));
    await seedDatabase(repository);
    const folder = (await repository.listFolders())[0];
    const demo = (await repository.listChats())[0];
    const child = await repository.createFolder("Personal folder", folder.id);
    const personal = await repository.createChat(folder.id);
    const library = await repository.library(demo.id);
    expect(library.chats).toEqual([{ ...personal, folderId: null }]);
    expect(library.folders).toEqual([{ ...child, parentId: null }]);
    expect(library.current?.chat.id).toBe(personal.id);
    expect((await getChat(new Request(`http://localhost/api/chats?id=${demo.id}`))).status).toBe(404);
    expect((await search(new Request(`http://localhost/api/search?chatId=${demo.id}&q=test`))).status).toBe(404);
    expect(await repository.hasMessages(demo.id)).toBe(false);
    expect((await repository.getChat(personal.id))?.folderId).toBe(folder.id);
  });

  it("restores on explicit opt-in and preserves edits and missing rows when merely shown again", async () => {
    const { userId, repository } = newUser();
    const other = newUser();
    setAuthResolverForTests(async () => ({ id: userId, email: null }));
    const action = (name: string) => demoAction(new Request("http://localhost/api/demo", {
      method: "POST", body: JSON.stringify({ action: name }),
    }));
    expect((await repository.library()).chats).toEqual([]);
    expect((await action("restore")).status).toBe(200);
    const demos = (await repository.library()).chats;
    expect(demos).toHaveLength(27);
    await repository.renameChat(demos[0].id, "My live demo");
    await repository.deleteChat(demos[1].id);
    await action("hide");
    expect((await repository.library()).chats).toEqual([]);
    await action("show");
    expect((await repository.library()).chats).toHaveLength(26);
    expect((await repository.getChat(demos[0].id))?.title).toBe("My live demo");
    expect(await other.repository.demoEnabled()).toBe(false);
    expect((await other.repository.library()).chats).toEqual([]);
    expect(await (await action("restore")).json()).toEqual({ addedFolders: 0, addedChats: 1 });
    expect((await repository.getChat(demos[0].id))?.title).toBe("My live demo");
  });
});
