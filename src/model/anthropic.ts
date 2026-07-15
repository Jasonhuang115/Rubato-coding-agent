// Anthropic provider — uses @anthropic-ai/sdk
// Supports: prompt caching, extended thinking, streaming content blocks

import Anthropic from "@anthropic-ai/sdk";
import type {
  ModelProvider,
  ChatParams,
  StreamEvent,
  ToolDefinition,
  Message as AgentMessage,
  ContentBlock,
} from "../core-types.js";

export class AnthropicProvider implements ModelProvider {
  readonly name = "anthropic";
  private client: Anthropic;

  constructor(apiKey?: string, baseURL?: string) {
    this.client = new Anthropic({
      apiKey: apiKey ?? process.env.ANTHROPIC_API_KEY ?? "sk-ant-not-set",
      baseURL: baseURL ?? process.env.ANTHROPIC_BASE_URL,
    });
  }

  supportsPromptCaching(): boolean {
    return true;
  }

  async countTokens(messages: AgentMessage[], system: string): Promise<number> {
    try {
      const params: Anthropic.Messages.MessageCountTokensParams = {
        model: "claude-sonnet-4-20250514", // placeholder — actual model chosen by caller
        messages: convertMessages(messages),
        system: system,
      };
      const result = await this.client.messages.countTokens(params);
      return result.input_tokens;
    } catch {
      // Fallback estimation
      let total = system.length;
      for (const m of messages) {
        if (typeof m.content === "string") total += m.content.length;
        else {
          for (const b of m.content) {
            if (b.type === "text") total += b.text.length;
            else if (b.type === "tool_result") total += (b.content?.length ?? 0);
            else if (b.type === "tool_use") total += JSON.stringify(b.input).length;
          }
        }
      }
      return Math.ceil(total / 3.5);
    }
  }

  async *chat(params: ChatParams): AsyncIterable<StreamEvent> {
    try {
      const stream = await this.client.messages.stream(
        {
          model: params.model,
          system: params.system,
          messages: convertMessages(params.messages),
          tools: convertTools(params.tools),
          max_tokens: params.maxTokens,
        },
        {
          signal: params.signal,
        }
      );

      // Track tool use accumulation
      const toolAccumulators = new Map<
        number,
        { id: string; name: string; partialJson: string }
      >();

      for await (const event of stream) {
        switch (event.type) {
          case "content_block_start": {
            const block = event.content_block;
            if (block.type === "tool_use") {
              toolAccumulators.set(event.index, {
                id: block.id,
                name: block.name,
                partialJson: "",
              });
              yield { type: "tool_use_start", id: block.id, name: block.name };
            }
            break;
          }

          case "content_block_delta": {
            const delta = event.delta;
            if (delta.type === "text_delta") {
              yield { type: "text_delta", text: delta.text };
            } else if (delta.type === "input_json_delta") {
              const acc = toolAccumulators.get(event.index);
              if (acc) {
                acc.partialJson += delta.partial_json;
                yield {
                  type: "tool_use_delta",
                  id: acc.id,
                  partialJson: delta.partial_json,
                };
              }
            } else if (delta.type === "thinking_delta") {
              yield { type: "thinking_delta", text: delta.thinking };
            }
            break;
          }

          case "content_block_stop": {
            yield { type: "content_block_stop", index: event.index };
            // If this was a tool use block, emit tool_use_end
            const acc = toolAccumulators.get(event.index);
            if (acc) {
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
              toolAccumulators.delete(event.index);
            }
            break;
          }

          case "message_stop": {
            const message = await stream.finalMessage();
            const stopReason: "end_turn" | "tool_use" | "max_tokens" =
              message.stop_reason === "tool_use"
                ? "tool_use"
                : message.stop_reason === "max_tokens"
                ? "max_tokens"
                : "end_turn";
            yield {
              type: "message_stop",
              stopReason,
              usage: {
                inputTokens: message.usage.input_tokens,
                outputTokens: message.usage.output_tokens,
              },
            };
            break;
          }
        }
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const retryable =
        err instanceof Anthropic.APIError
          ? (err.status ?? 0) >= 500 || err.status === 429
          : true;

      yield { type: "error", message, retryable };
    }
  }
}

// ---- Conversion helpers ----

function convertMessages(
  messages: AgentMessage[]
): Anthropic.Messages.MessageParam[] {
  return messages.map((m) => {
    if (typeof m.content === "string") {
      return { role: m.role, content: m.content };
    }

    const blocks: Anthropic.Messages.ContentBlockParam[] = [];

    for (const block of m.content) {
      switch (block.type) {
        case "text":
          blocks.push({ type: "text", text: block.text });
          break;
        case "tool_use":
          blocks.push({
            type: "tool_use",
            id: block.id,
            name: block.name,
            input: block.input,
          });
          break;
        case "tool_result":
          blocks.push({
            type: "tool_result",
            tool_use_id: block.tool_use_id,
            content: block.content,
            is_error: block.is_error,
          });
          break;
      }
    }

    return {
      role: m.role,
      content: blocks,
    };
  });
}

function convertTools(
  tools: ToolDefinition[]
): Anthropic.Messages.Tool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: {
      type: "object" as const,
      properties: t.inputSchema.properties,
      required: t.inputSchema.required,
    },
  }));
}
