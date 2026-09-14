import { createAnthropic } from "@ai-sdk/anthropic";
import { generateText, streamText } from "ai";
import { briefingSchema } from "../context";
import { modelFor } from "../models";
import type { ChatProvider } from "./types";
import { consumeStream, sdkPrompt } from "./stream";

interface AnthropicOptions {
  apiKey: string;
}

/** Claude 5 and Opus models reject sampling overrides; older Sonnet/Haiku still accept a deterministic temperature. */
function samplingOverrides(model: ReturnType<typeof modelFor>) {
  const generation = Number(/^claude-[a-z]+-(\d+)/.exec(model.id)?.[1] ?? 0);
  return generation >= 5 || model.id.startsWith("claude-opus") ? {} : { temperature: 0 };
}

export function createAnthropicProvider({ apiKey }: AnthropicOptions): ChatProvider {
  const anthropic = createAnthropic({ apiKey });

  return {
    async *streamChat({ messages, modelKey, signal }) {
      const model = modelFor(modelKey);
      const result = streamText({
        model: anthropic(model.id),
        ...sdkPrompt(messages),
        allowSystemInMessages: false,
        abortSignal: signal,
        maxRetries: 0,
        maxOutputTokens: 32_000,
        ...samplingOverrides(model),
        onError: () => {},
      });
      yield* consumeStream(result.fullStream, signal, "Claude");
    },

    async compress({ messages, direction, signal }) {
      signal?.throwIfAborted();
      const prompt = sdkPrompt(messages);
      const result = await generateText({
        model: anthropic(modelFor("haiku").id),
        system: [{ role: "system", content: `Create a compact frozen briefing for ${direction}. Summarize only the supplied conversation. Preserve the user's goal, constraints, decisions and their reasons, referenced artifacts, and open questions. Return only JSON matching this example: {"goal":"User goal","constraints":["Requirement"],"decisions":["Choice and reason"],"artifacts":["File or document"],"open_questions":["Unresolved question"]}. Use empty arrays when appropriate. Do not add Markdown fences or commentary.` }, ...prompt.system],
        messages: prompt.messages,
        allowSystemInMessages: false,
        abortSignal: signal,
        maxRetries: 0,
        maxOutputTokens: 2048,
        temperature: 0,
      });
      signal?.throwIfAborted();
      return briefingSchema.parse(JSON.parse(result.text));
    },
  };
}
