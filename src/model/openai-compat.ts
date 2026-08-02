// OpenAI-compatible provider for Groq, OpenRouter, vLLM, Ollama, and peers.

import OpenAI from "openai";
import type {
  ChatParams,
  Message,
  ModelProvider,
  StreamEvent,
} from "../shared/core-types.js";
import {
  streamOpenAIChunks,
  toOpenAIMessages,
  toOpenAITools,
} from "./openai-wire.js";

export class OpenAICompatProvider implements ModelProvider {
  readonly name: string;
  private client: OpenAI;

  constructor(name: string, baseURL: string, apiKey?: string) {
    this.name = name;
    this.client = new OpenAI({
      apiKey: apiKey ?? process.env.OPENAI_API_KEY ?? "sk-not-set",
      baseURL,
    });
  }

  supportsPromptCaching(): boolean {
    return false;
  }

  async countTokens(messages: Message[], system: string): Promise<number> {
    let total = system.length;
    for (const message of messages) {
      if (typeof message.content === "string") {
        total += message.content.length;
      } else {
        for (const block of message.content) {
          if (block.type === "text") total += block.text.length;
          else if (block.type === "tool_result") total += block.content?.length ?? 0;
          else if (block.type === "tool_use") total += JSON.stringify(block.input).length;
        }
      }
    }
    return Math.ceil(total / 3);
  }

  async *chat(params: ChatParams): AsyncIterable<StreamEvent> {
    try {
      const stream = await this.client.chat.completions.create(
        {
          model: params.model,
          messages: [
            { role: "system", content: params.system },
            ...toOpenAIMessages(params.messages),
          ],
          tools: toOpenAITools(params.tools),
          max_tokens: params.maxTokens,
          stream: true,
          stream_options: { include_usage: true },
        },
        { signal: params.signal },
      );
      yield* streamOpenAIChunks(stream);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      const retryable = error instanceof OpenAI.APIError
        ? (error.status ?? 0) >= 500 || error.status === 429
        : true;
      yield { type: "error", message, retryable };
    }
  }
}
