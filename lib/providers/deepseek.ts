import { createOpenAI } from "@ai-sdk/openai";
import { generateText, streamText } from "ai";
import { briefingSchema } from "../context";
import { AppError } from "../errors";
import { COMPRESSION_MODEL, modelFor } from "../models";
import type { ChatProvider } from "./types";
import { consumeStream, sdkPrompt } from "./stream";

interface DeepSeekOptions {
  apiKey: string;
  requestOptions: (thinking: boolean) => Record<string, unknown>;
}

export function createDeepSeekProvider({ apiKey, requestOptions }: DeepSeekOptions): ChatProvider {
  function client(thinking: boolean, json = false) {
    return createOpenAI({
      baseURL: "https://api.deepseek.com",
      apiKey,
      name: "deepseek",
      fetch(url, init) {
        if (typeof init?.body !== "string") throw new AppError("The provider request could not be prepared.", 500, "provider_request");
        const body = JSON.parse(init.body) as Record<string, unknown>;
        return globalThis.fetch(url, {
          ...init,
          body: JSON.stringify({ ...body, ...requestOptions(thinking), ...(json ? { response_format: { type: "json_object" } } : {}) }),
        });
      },
    });
  }

  return {
    async *streamChat({ messages, modelKey, signal }) {
      const model = modelFor(modelKey);
      const result = streamText({
        model: client(model.thinking).chat(model.id),
        ...sdkPrompt(messages),
        allowSystemInMessages: false,
        abortSignal: signal,
        maxRetries: 0,
        temperature: 0,
        onError: () => {},
      });
      yield* consumeStream(result.fullStream, signal, "DeepSeek");
    },

    async compress({ messages, direction, signal }) {
      signal?.throwIfAborted();
      const prompt = sdkPrompt(messages);
      const result = await generateText({
        model: client(false, true).chat(COMPRESSION_MODEL),
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
