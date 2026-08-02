// DeepSeek provider — uses OpenAI-compatible API
// Base URL: https://api.deepseek.com/v1
// Models: deepseek-chat (Pro), deepseek-chat (Flash via query param or different model name)

import OpenAI from "openai";
import type {
  ModelProvider,
  ChatParams,
  StreamEvent,
  Message,
} from "../shared/core-types.js";
import {
  streamOpenAIChunks,
  toOpenAIMessages,
  toOpenAITools,
} from "./openai-wire.js";

export class DeepSeekProvider implements ModelProvider {
  readonly name = "deepseek";
  private client: OpenAI;

  constructor(apiKey?: string, baseURL?: string) {
    this.client = new OpenAI({
      apiKey: apiKey ?? process.env.DEEPSEEK_API_KEY ?? "sk-not-set",
      baseURL: baseURL ?? process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com/v1",
    });
  }

  supportsPromptCaching(): boolean {
    return false; // DeepSeek doesn't support prompt caching yet
  }

  async countTokens(messages: Message[], system: string): Promise<number> {
    // DeepSeek doesn't have a dedicated tokenizer API — estimate at 3 chars/token
    let total = system.length;
    for (const m of messages) {
      if (typeof m.content === "string") {
        total += m.content.length;
      } else {
        for (const block of m.content) {
          if (block.type === "text") total += block.text.length;
          else if (block.type === "tool_result") total += (block.content?.length ?? 0);
          else if (block.type === "tool_use") total += JSON.stringify(block.input).length;
        }
      }
    }
    return Math.ceil(total / 3);
  }

  async *chat(params: ChatParams): AsyncIterable<StreamEvent> {
    const messages = toOpenAIMessages(params.messages);

    try {
      const stream = await this.client.chat.completions.create(
        {
          model: params.model,
          messages: [
            { role: "system", content: params.system },
            ...messages,
          ],
          tools: toOpenAITools(params.tools),
          max_tokens: params.maxTokens,
          stream: true,
          stream_options: { include_usage: true },
        },
        {
          signal: params.signal,
        }
      );

      yield* streamOpenAIChunks(stream);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const retryable =
        err instanceof OpenAI.APIError
          ? (err.status ?? 0) >= 500 || err.status === 429
          : true;

      yield { type: "error", message, retryable };
    }
  }
}
