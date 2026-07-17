// DeepSeek provider — uses OpenAI-compatible API
// Base URL: https://api.deepseek.com/v1
// Models: deepseek-chat (Pro), deepseek-chat (Flash via query param or different model name)

import OpenAI from "openai";
import type {
  ModelProvider,
  ChatParams,
  StreamEvent,
  ToolDefinition,
  Message,
  TokenUsage,
} from "../core-types.js";

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
    const messages = convertMessages(params.messages);

    try {
      const stream = await this.client.chat.completions.create(
        {
          model: params.model,
          messages: [
            { role: "system", content: params.system },
            ...messages,
          ],
          tools: convertTools(params.tools),
          max_tokens: params.maxTokens,
          stream: true,
          stream_options: { include_usage: true },
        },
        {
          signal: params.signal,
        }
      );

      let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
      const toolUseAccumulators = new Map<
        number,
        { id: string; name: string; partialJson: string; started: boolean }
      >();

      for await (const chunk of stream) {
        // Handle usage info (sent via stream_options.include_usage)
        if (chunk.usage) {
          usage = {
            inputTokens: chunk.usage.prompt_tokens ?? 0,
            outputTokens: chunk.usage.completion_tokens ?? 0,
          };
        }

        const choice = chunk.choices?.[0];
        if (!choice) continue;

        const delta = choice.delta;
        if (!delta) continue;

        // --- Reasoning/Thinking content (DeepSeek-R1, V4 Pro, etc.) ---
        if ((delta as Record<string, unknown>).reasoning_content) {
          yield {
            type: "thinking_delta",
            text: (delta as Record<string, unknown>).reasoning_content as string,
          };
        }

        // --- Text content ---
        if (delta.content) {
          yield { type: "text_delta", text: delta.content };
        }

        // --- Tool calls ---
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index;
            let acc = toolUseAccumulators.get(idx);

            if (tc.id) {
              // New tool call starting
              acc = {
                id: tc.id,
                name: tc.function?.name ?? "",
                partialJson: tc.function?.arguments ?? "",
                started: false,
              };
              toolUseAccumulators.set(idx, acc);
            }

            if (!acc) continue;

            // Emit tool_use_start on first appearance
            if (!acc.started && acc.name) {
              acc.started = true;
              yield { type: "tool_use_start", id: acc.id, name: acc.name };
            }

            // Accumulate arguments
            if (tc.function?.arguments) {
              acc.partialJson += tc.function.arguments;
              yield {
                type: "tool_use_delta",
                id: acc.id,
                partialJson: tc.function.arguments,
              };
            }
          }
        }

        // --- Finish ---
        const finishReason = choice.finish_reason;
        if (finishReason) {
          // Flush any accumulated tool uses
          for (const [, acc] of toolUseAccumulators) {
            if (acc.started) {
              try {
                const input = JSON.parse(acc.partialJson);
                yield {
                  type: "tool_use_end",
                  id: acc.id,
                  input: input as Record<string, unknown>,
                };
              } catch {
                yield {
                  type: "tool_use_end",
                  id: acc.id,
                  input: { _incomplete: true, _raw: acc.partialJson },
                };
              }
            }
          }
          toolUseAccumulators.clear();

          const stopReason = finishReason === "tool_calls"
            ? "tool_use"
            : finishReason === "stop"
            ? "end_turn"
            : "max_tokens";

          yield { type: "message_stop", stopReason, usage };
        }
      }
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

// ---- Message conversion helpers ----

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function convertMessages(messages: Message[]): any[] {
  return messages.map((m) => {
    if (typeof m.content === "string") {
      return { role: m.role as "user" | "assistant", content: m.content };
    }

    const parts: string[] = [];
    const toolCalls: Array<{
      id: string;
      type: "function";
      function: { name: string; arguments: string };
    }> = [];
    let toolCallId: string | undefined;

    for (const block of m.content) {
      switch (block.type) {
        case "text":
          parts.push(block.text);
          break;
        case "tool_use":
          toolCalls.push({
            id: block.id,
            type: "function",
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input),
            },
          });
          if (!toolCallId) toolCallId = block.id;
          break;
        case "tool_result":
          // tool_result blocks become separate tool-role messages
          // We handle this by returning multiple messages if needed
          // For simplicity, we add them sequentially
          toolCallId = block.tool_use_id;
          parts.push(block.content ?? "");
          break;
      }
    }

    // For tool results, emit as tool role
    if (toolCallId && toolCalls.length === 0) {
      return {
        role: "tool",
        content: parts.join("\n") || "",
        tool_call_id: toolCallId,
      };
    }

    // For assistant with tool_calls
    if (toolCalls.length > 0) {
      return {
        role: "assistant",
        content: parts.length > 0 ? parts.join("\n") : "",
        tool_calls: toolCalls,
      };
    }

    return {
      role: m.role as "user" | "assistant",
      content: parts.join("\n") || "",
    };
  });
}

function convertTools(
  tools: ToolDefinition[]
): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema as Record<string, unknown>,
    },
  }));
}
