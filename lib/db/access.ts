import { getDatabase, type DatabaseHandle } from "./client";
import { GenerationStore } from "./jobs";
import { ChatRepository } from "./repository";

export interface UserData {
  repository: ChatRepository;
  jobs: GenerationStore;
}

export function dataFor(userId: string, handle: DatabaseHandle = getDatabase(), guest = false): UserData {
  return { repository: new ChatRepository(handle, userId, guest), jobs: new GenerationStore(handle, userId, guest) };
}
