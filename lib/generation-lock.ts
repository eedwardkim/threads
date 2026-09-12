import { AppError } from "./errors";
import { ONE_GENERATION_AT_A_TIME } from "./generation-policy";

const generationGlobal = globalThis as typeof globalThis & {
  __marginGenerationControllers?: Map<string, AbortController>;
};
const controllers = generationGlobal.__marginGenerationControllers ??= new Map<string, AbortController>();

function busy() {
  return new AppError("Another operation is running. Stop it or wait for it to finish.", 409, "generation_busy");
}

export function assertIdle(): void {
  if (ONE_GENERATION_AT_A_TIME && controllers.size > 0) throw busy();
}

export function acquireGeneration(id: string, signal?: AbortSignal): { controller: AbortController; release: () => void } {
  assertIdle();
  if (controllers.has(id)) throw busy();
  const controller = new AbortController();
  controllers.set(id, controller);
  const forwardAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", forwardAbort, { once: true });
  if (signal?.aborted) forwardAbort();
  return {
    controller,
    release() {
      signal?.removeEventListener("abort", forwardAbort);
      if (controllers.get(id) === controller) controllers.delete(id);
    },
  };
}

export function stopGeneration(id?: string): void {
  if (id !== undefined) controllers.get(id)?.abort();
  else for (const controller of controllers.values()) controller.abort();
}
