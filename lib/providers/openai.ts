import { createOpenAI } from "@ai-sdk/openai";
import { generateText, streamText } from "ai";
import { briefingSchema } from "../context";
import { modelFor } from "../models";
import type { ChatProvider } from "./types";
import { consumeStream, sdkPrompt } from "./stream";

interface OpenAIOptions {
  apiKey: string;
}

export function createOpenAIProvider({ apiKey }: OpenAIOptions): ChatProvider {
  const openai = createOpenAI({ apiKey });

  return {
    async *streamChat({ messages, modelKey, signal }) {
      const model = modelFor(modelKey);
      const result = streamText({
        model: openai.chat(model.id),
        ...sdkPrompt(messages),
        allowSystemInMessages: false,
        abortSignal: signal,
        maxRetries: 0,
        onError: () => {},
      });
      yield* consumeStream(result.fullStream, signal, "OpenAI");
    },

    async compress({ messages, direction, signal }) {
      signal?.throwIfAborted();
      const prompt = sdkPrompt(messages);
      const result = await generateText({
        model: openai.chat(modelFor("gpt-5.4-mini").id),
        system: [{ role: "system", content: `Create a compact frozen briefing for ${direction}. Summarize only the supplied conversation. Preserve the user's goal, constraints, decisions and their reasons, referenced artifacts, and open questions. Return only JSON matching this example: {"goal":"User goal","constraints":["Requirement"],"decisions":["Choice and reason"],"artifacts":["File or document"],"open_questions":["Unresolved question"]}. Use empty arrays when appropriate. Do not add Markdown fences or commentary.` }, ...prompt.system],
        messages: prompt.messages,
        allowSystemInMessages: false,
        abortSignal: signal,
        maxRetries: 0,
        maxOutputTokens: 2048,
      });
      signal?.throwIfAborted();
      return briefingSchema.parse(JSON.parse(result.text));
    },
  };
}
