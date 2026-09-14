import { getDatabase, type DatabaseHandle } from "./client";
import { GenerationStore } from "./jobs";
import { ChatRepository } from "./repository";

export interface UserData {
  repository: ChatRepository;
  jobs: GenerationStore;
}

export function dataFor(userId: string, handle: DatabaseHandle = getDatabase()): UserData {
  return { repository: new ChatRepository(handle, userId), jobs: new GenerationStore(handle, userId) };
}
