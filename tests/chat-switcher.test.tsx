import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useThemePreference } from "../lib/preferences";
import { ChatSwitcher } from "../components/chat-switcher";
import { NameDialog } from "../components/name-dialog";
import { Sidebar } from "../components/sidebar";
import { MoveToDialog } from "../components/move-to-dialog";
import { CHAT_DRAG_MIME } from "../lib/drag-ghost";
import { DEMO_FOLDERS } from "../lib/demo-catalog";
import type { Chat, Folder } from "../lib/types";

const folders: Folder[] = [
  { id: "work", name: "Work", parentId: null, createdAt: 1, sortOrder: 0 },
  { id: "reading", name: "Reading", parentId: "work", createdAt: 2, sortOrder: 0 },
];
const chats: Chat[] = [
  { id: "notes", title: "Project notes", folderId: null, createdAt: 1 },
  { id: "research", title: "Research questions", folderId: "reading", createdAt: 2 },
];
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function element<T extends HTMLElement>(selector: string): T {
  const result = document.querySelector<T>(selector);
  expect(result, `Missing ${selector}`).not.toBeNull();
  return result!;
}

async function click(label: string) {
  await act(async () => element<HTMLButtonElement>(`button[aria-label="${label}"]`).click());
}

async function type(selector: string, value: string) {
  const input = element<HTMLInputElement>(selector);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function key(target: HTMLElement, value: string) {
  await act(async () => target.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true })));
}

async function submitName() {
  await act(async () => element(".name-dialog form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
}

function transfer(internal = true): DataTransfer {
  const values = new Map([["text/plain", "notes"]]);
  if (internal) values.set(CHAT_DRAG_MIME, "notes");
  return {
    get types() { return Array.from(values.keys()); },
    getData: (type: string) => values.get(type) ?? "",
    setData: (type: string, value: string) => values.set(type, value),
    setDragImage: vi.fn(), effectAllowed: "move", dropEffect: "move",
  } as unknown as DataTransfer;
}

async function drag(target: HTMLElement, type: string, dataTransfer: DataTransfer) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
  await act(async () => target.dispatchEvent(event));
  return event;
}

async function renderBrowser(overrides: Partial<ComponentProps<typeof ChatSwitcher>> = {}) {
  const props = {
    chats, folders, currentChatId: "notes", onClose: vi.fn(), onSelect: vi.fn(), onNewChat: vi.fn(),
    onCreateFolder: vi.fn(), onMoveChat: vi.fn(), onRenameChat: vi.fn(), onRenameFolder: vi.fn(), ...overrides,
  };
  await act(async () => root.render(<ChatSwitcher {...props} />));
  return props;
}

async function renderName(overrides: Partial<ComponentProps<typeof NameDialog>> = {}) {
  const props = {
    title: "Rename conversation", description: "Only the name changes.", label: "Conversation name",
    initialValue: "Project notes", onSave: vi.fn().mockResolvedValue(undefined), onClose: vi.fn(), ...overrides,
  };
  await act(async () => root.render(<NameDialog {...props} />));
  return props;
}

describe("folder browser", () => {
  it("restores demos without closing the library and disables repeated or busy restores", async () => {
    const onRestoreDemo = vi.fn();
    const props = await renderBrowser({ onRestoreDemo });
    await click("Restore demo library");
    expect(onRestoreDemo).toHaveBeenCalledOnce();
    expect(props.onClose).not.toHaveBeenCalled();
    await renderBrowser({ onRestoreDemo, restoringDemo: true });
    expect(element<HTMLButtonElement>('[aria-label="Restore demo library"]').disabled).toBe(true);
    expect(element('[aria-label="Restore demo library"]').textContent).toContain("Restoring");
    await click("Restore demo library");
    await renderBrowser({ onRestoreDemo, restoreDisabled: true });
    await click("Restore demo library");
    expect(onRestoreDemo).toHaveBeenCalledOnce();
  });

  it("offers conversation and folder renaming without opening or closing the browser", async () => {
    const props = await renderBrowser();
    await click("Rename conversation: Project notes");
    expect(props.onRenameChat).toHaveBeenCalledWith(chats[0]);
    await click("Rename folder: Work");
    expect(props.onRenameFolder).toHaveBeenCalledWith(folders[0]);
    expect(props.onSelect).not.toHaveBeenCalled();
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it("supports F2 renaming for keyboard users", async () => {
    const props = await renderBrowser();
    await key(element('[aria-label="Open conversation: Project notes"]'), "F2");
    expect(props.onRenameChat).toHaveBeenCalledWith(chats[0]);
    await key(element('[aria-label="Open folder: Work"]'), "F2");
    expect(props.onRenameFolder).toHaveBeenCalledWith(folders[0]);
    expect(props.onSelect).not.toHaveBeenCalled();
  });

  it("creates folders and conversations in the location being browsed", async () => {
    const props = await renderBrowser();
    await click("Open folder: Work");
    await click("New folder");
    expect(props.onCreateFolder).toHaveBeenCalledWith("work");
    await click("New conversation");
    expect(props.onNewChat).toHaveBeenCalledWith("work");
    expect(props.onClose).toHaveBeenCalledOnce();
  });

  it("finds folders and conversations across the library with parent paths", async () => {
    await renderBrowser();
    await type('[aria-label="Search library"]', "read");
    expect(element('[aria-label="Open folder: Reading"]').textContent).toContain("Work");
    await type('[aria-label="Search library"]', "research");
    expect(element('[aria-label="Open conversation: Research questions"]').textContent).toContain("Work / Reading");
    expect(document.querySelector('[aria-label="Open conversation: Project notes"]')).toBeNull();
    await click("Clear search");
    expect(document.querySelector('[aria-label="Open conversation: Project notes"]')).not.toBeNull();
  });

  it("keeps rename actions available in compact list view", async () => {
    const props = await renderBrowser();
    await click("List view");
    expect(element('[aria-label="List view"]').getAttribute("aria-pressed")).toBe("true");
    await click("Rename conversation: Project notes");
    expect(props.onRenameChat).toHaveBeenCalledWith(chats[0]);
  });

  it("preserves navigation and reflects renamed items when props refresh", async () => {
    await renderBrowser();
    await click("Open folder: Work");
    await click("Open folder: Reading");
    await renderBrowser({ chats: [chats[0], { ...chats[1], title: "Updated notes" }], folders: [folders[0], { ...folders[1], name: "Books" }] });
    expect(element(".fb-breadcrumb").textContent).toContain("Books");
    expect(document.querySelector('[aria-label="Rename conversation: Updated notes"]')).not.toBeNull();
    await click("Back to parent folder");
    expect(document.querySelector('[aria-label="Open folder: Books"]')).not.toBeNull();
  });

  it("returns to the library if the browsed folder is removed", async () => {
    await renderBrowser();
    await click("Open folder: Work");
    await renderBrowser({ folders: [] });
    expect(document.querySelector('[aria-label="Open conversation: Project notes"]')).not.toBeNull();
    expect(element(".fb-breadcrumb").textContent).toBe("Library");
  });

  it("keeps drag-to-folder and the custom drag image working", async () => {
    const props = await renderBrowser();
    const data = transfer();
    await drag(element(".fb-chat-card"), "dragstart", data);
    expect(element(".chat-drag-ghost").textContent).toContain("Project notes");
    await drag(element(".fb-folder-card"), "dragover", data);
    expect(element(".fb-folder-card").classList.contains("is-drop-target")).toBe(true);
    await drag(element(".fb-folder-card"), "drop", data);
    expect(props.onMoveChat).toHaveBeenCalledExactlyOnceWith("notes", "work");
    expect(document.querySelector(".chat-drag-ghost")).toBeNull();
    expect(document.querySelector(".is-drag-source")).toBeNull();
  });

  it("allows dropping on the Library breadcrumb to unfile a conversation", async () => {
    const props = await renderBrowser();
    await click("Open folder: Work");
    await drag(element(".fb-breadcrumb button"), "drop", transfer());
    expect(props.onMoveChat).toHaveBeenCalledExactlyOnceWith("notes", null);
  });

  it("ignores external text drops", async () => {
    const props = await renderBrowser();
    const over = await drag(element(".fb-folder-card"), "dragover", transfer(false));
    await drag(element(".fb-folder-card"), "drop", transfer(false));
    expect(over.defaultPrevented).toBe(false);
    expect(props.onMoveChat).not.toHaveBeenCalled();
  });
});

describe("name dialog", () => {
  it("focuses and selects the original name, then saves trimmed text", async () => {
    const props = await renderName();
    const input = element<HTMLInputElement>(".name-field");
    expect(document.activeElement).toBe(input);
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, "Project notes".length]);
    await type(".name-field", "  New title  ");
    await submitName();
    expect(props.onSave).toHaveBeenCalledExactlyOnceWith("New title");
    expect(props.onClose).toHaveBeenCalledOnce();
  });

  it("never saves on blur or Escape", async () => {
    const props = await renderName();
    await type(".name-field", "Discard this draft");
    await act(async () => element<HTMLInputElement>(".name-field").blur());
    expect(props.onSave).not.toHaveBeenCalled();
    await key(element(".name-field"), "Escape");
    expect(props.onClose).toHaveBeenCalledOnce();
    expect(props.onSave).not.toHaveBeenCalled();
  });

  it("rejects whitespace and skips unchanged names", async () => {
    const props = await renderName();
    await type(".name-field", "   ");
    expect(element<HTMLButtonElement>('.name-dialog [type="submit"]').disabled).toBe(true);
    await submitName();
    expect(props.onSave).not.toHaveBeenCalled();
    expect(props.onClose).not.toHaveBeenCalled();
    await type(".name-field", "Project notes");
    await submitName();
    expect(props.onSave).not.toHaveBeenCalled();
    expect(props.onClose).toHaveBeenCalledOnce();
  });

  it("keeps the draft and exposes a retryable save failure", async () => {
    const onSave = vi.fn().mockRejectedValueOnce(new Error("Could not rename. Try again.")).mockResolvedValueOnce(undefined);
    const props = await renderName({ onSave });
    await type(".name-field", "Keep this draft");
    await submitName();
    expect(element<HTMLInputElement>(".name-field").value).toBe("Keep this draft");
    expect(element('[role="alert"]').textContent).toBe("Could not rename. Try again.");
    expect(document.activeElement).toBe(element(".name-field"));
    expect(props.onClose).not.toHaveBeenCalled();
    await submitName();
    expect(onSave).toHaveBeenCalledTimes(2);
    expect(props.onClose).toHaveBeenCalledOnce();
  });

  it("blocks duplicate submissions and dismissal while saving", async () => {
    let resolve!: () => void;
    const pending = new Promise<void>((done) => { resolve = done; });
    const props = await renderName({ onSave: vi.fn(() => pending) });
    await type(".name-field", "Saving title");
    await submitName();
    await submitName();
    expect(element<HTMLInputElement>(".name-field").disabled).toBe(true);
    await key(element(".name-field"), "Escape");
    await click("Close dialog");
    expect(props.onSave).toHaveBeenCalledOnce();
    expect(props.onClose).not.toHaveBeenCalled();
    await act(async () => resolve());
    expect(props.onClose).toHaveBeenCalledOnce();
  });
});

describe("sidebar theme preference", () => {
  function ThemePreview() {
    const [theme] = useThemePreference();
    return <span data-theme={theme}>{theme}</span>;
  }

  it("renders light mode on the server before hydration", () => {
    expect(renderToStaticMarkup(<ThemePreview />)).toContain('data-theme="light"');
  });

  it.each([
    [null, "light"],
    ["invalid", "light"],
    ["light", "light"],
    ["dark", "dark"],
  ])("loads %s as %s without overriding a saved theme", async (saved, expected) => {
    vi.spyOn(Storage.prototype, "getItem").mockReturnValue(saved);
    await act(async () => root.render(<ThemePreview />));
    expect(host.textContent).toBe(expected);
  });

  it("defaults to light when browser storage is unavailable", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("Storage unavailable"); });
    await act(async () => root.render(<ThemePreview />));
    expect(host.textContent).toBe("light");
  });
});

describe("sidebar organization", () => {
  async function renderSidebar(overrides: Partial<ComponentProps<typeof Sidebar>> = {}) {
    const props = {
      chats, folders, currentChatId: "notes", threads: [], mobileOpen: false, theme: "dark", locked: false, searchOpen: false,
      onChat: vi.fn(), onNewChat: vi.fn(), onDeleteChat: vi.fn(), onMoveChat: vi.fn(), onRenameChat: vi.fn(),
      onDropChat: vi.fn(), onRenameFolder: vi.fn(), onDeleteFolder: vi.fn(), onMoveFolder: vi.fn(), onCreateFolder: vi.fn(),
      onRenameThread: vi.fn(), onDeleteThread: vi.fn(), onCloseMobile: vi.fn(), onToggleTheme: vi.fn(), onSearch: vi.fn(), onSwitcher: vi.fn(), ...overrides,
    };
    await act(async () => root.render(<Sidebar {...props} />));
    return props;
  }

  it("starts demo folders collapsed without collapsing personal folders", async () => {
    const demo = DEMO_FOLDERS[0];
    await renderSidebar({
      folders: [...folders, { id: demo.id, name: demo.name, parentId: null, createdAt: 1, sortOrder: 0 }],
      chats: [...chats, { ...demo.chats[0], folderId: demo.id }],
    });
    expect(element('[aria-label="Collapse folder: Work"]').getAttribute("aria-expanded")).toBe("true");
    expect(element('[aria-label="Expand folder: Linear Algebra"]').getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector(`.chat-link[title="${demo.chats[0].title}"]`)).toBeNull();
    await click("Expand folder: Linear Algebra");
    expect(document.querySelector(`.chat-link[title="${demo.chats[0].title}"]`)).not.toBeNull();
  });

  it("shows folder counts, an Unsorted section, and an explicit library button", async () => {
    const props = await renderSidebar();
    expect(element(".unsorted-heading").textContent).toContain("Unsorted");
    expect(document.querySelectorAll(".folder-count")).toHaveLength(2);
    await click("Browse library");
    expect(props.onSwitcher).toHaveBeenCalledOnce();
    await click("New folder");
    expect(props.onCreateFolder).toHaveBeenCalledWith(null);
  });

  it("provides unclipped, keyboard-accessible folder menus", async () => {
    const props = await renderSidebar();
    await click("Folder options: Work");
    const menu = element('[role="menu"]');
    expect(menu.closest(".sidebar")).toBeNull();
    expect(document.activeElement?.textContent).toContain("Rename");
    await key(document.activeElement as HTMLElement, "ArrowDown");
    expect(document.activeElement?.textContent).toContain("Move to");
    await key(document.activeElement as HTMLElement, "r");
    expect(props.onRenameFolder).toHaveBeenCalledExactlyOnceWith(folders[0]);
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(element('[aria-label="Folder options: Work"]'));
  });

  it("renames a conversation through its options without navigating", async () => {
    const props = await renderSidebar();
    await click("Conversation options: Project notes");
    await act(async () => element<HTMLButtonElement>('[role="menuitem"]').click());
    expect(props.onRenameChat).toHaveBeenCalledExactlyOnceWith(chats[0]);
    expect(props.onChat).not.toHaveBeenCalled();
  });

  it("preserves sidebar drag-and-drop into nested folders", async () => {
    const props = await renderSidebar();
    const row = element('[title="Project notes"]').closest<HTMLElement>(".chat-list-row")!;
    const destination = element('[title="Reading"]').closest<HTMLElement>(".folder-row")!;
    const data = transfer();
    await drag(row, "dragstart", data);
    await drag(destination, "drop", data);
    await drag(row, "dragend", data);
    expect(props.onDropChat).toHaveBeenCalledExactlyOnceWith("notes", "reading");
    expect(document.querySelector(".chat-drag-ghost")).toBeNull();
  });
});

describe("move dialog", () => {
  it("keeps failed moves open and shows a recoverable error", async () => {
    const onClose = vi.fn();
    const onMove = vi.fn().mockRejectedValueOnce(new Error("Destination is unavailable.")).mockResolvedValueOnce(undefined);
    await act(async () => root.render(<MoveToDialog folders={folders} currentFolderId={null} onMove={onMove} onCreateFolder={vi.fn()} onClose={onClose} />));
    const destination = Array.from(document.querySelectorAll<HTMLButtonElement>(".move-to-results button")).find((button) => button.textContent?.includes("Reading"))!;
    expect(destination.textContent).toContain("Work");
    await act(async () => destination.click());
    expect(onClose).not.toHaveBeenCalled();
    expect(element('[role="alert"]').textContent).toBe("Destination is unavailable.");
    await act(async () => destination.click());
    expect(onMove).toHaveBeenLastCalledWith("reading");
    expect(onClose).toHaveBeenCalledOnce();
  });
});
