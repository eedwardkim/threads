import type { ModelKey } from "./models";

export interface Folder {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: number;
  sortOrder: number;
  /** Stable catalog key when this folder is a prewritten demo instance. */
  demoKey: string | null;
}

export interface Chat {
  id: string;
  title: string;
  folderId: string | null;
  createdAt: number;
  /** Stable catalog key when this chat is a prewritten demo instance. */
  demoKey: string | null;
}

export type AttachmentMediaType = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

/** Image metadata shown in the UI and carried into prompts; bytes are fetched separately. */
export interface Attachment {
  id: string;
  name: string;
  mediaType: AttachmentMediaType;
  width: number;
  height: number;
  byteSize: number;
  /** Cached structured description; null until a text-only model (or an older turn) first needs it. */
  digest: string | null;
}

export interface Message {
  id: string;
  chatId: string;
  threadId: string | null;
  role: "user" | "assistant";
  content: string;
  modelKey: ModelKey | null;
  complete: boolean;
  inputTokens: number | null;
  outputTokens: number | null;
  createdAt: number;
  /** Images sent with a user message; absent means none. */
  attachments?: Attachment[];
}

export interface Thread {
  id: string;
  chatId: string;
  parentMessageId: string;
  anchorStart: number;
  anchorEnd: number;
  anchorExact: string;
  compressedContext: string | null;
  contextFrozenAt: number | null;
  source: "user";
  resolved: boolean;
  title: string;
  createdAt: number;
  anchorValid: boolean;
  messageCount: number;
}

export interface PromptImage {
  data: Uint8Array;
  mediaType: AttachmentMediaType;
}

export interface PromptMessage {
  role: "system" | "user" | "assistant";
  content: string;
  /** Images the user sent with this turn; how they reach the model is decided at generation time. */
  attachments?: Attachment[];
  /** Native image parts for models that see images; set only for the turns chosen by `lib/vision.ts`. */
  images?: PromptImage[];
}

export interface Briefing {
  goal: string;
  constraints: string[];
  decisions: string[];
  artifacts: string[];
  open_questions: string[];
}

export type FrozenContext =
  | { kind: "compressed"; briefing: Briefing }
  | { kind: "fallback"; messages: PromptMessage[] };

export interface ContextInfo {
  tokens: number;
  fullTokens: number;
  actual: boolean;
  newMessages: number;
  fallback: boolean;
  briefing: FrozenContext | null;
}

export interface ChatData {
  chat: Chat;
  messages: Message[];
  threads: Thread[];
}

export interface ThreadData {
  thread: Thread;
  parentMessage: Message;
  messages: Message[];
  context: ContextInfo;
}

export interface AppData {
  chats: Chat[];
  folders: Folder[];
  current: ChatData | null;
}

export interface SearchResult {
  id: string;
  threadId: string | null;
  threadTitle: string | null;
  role: Message["role"];
  excerpt: string;
}

export interface ProviderStatus {
  mock: boolean;
  deepseek: boolean;
  anthropic: boolean;
  openai: boolean;
}

export type StreamEvent =
  | { type: "start"; message: Message; userMessage: Message | null }
  | { type: "delta"; messageId: string; text: string }
  | { type: "finish"; message: Message }
  | { type: "error"; message: string; code: string; messageId?: string };
