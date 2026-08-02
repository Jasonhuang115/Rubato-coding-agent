import type OpenAI from "openai";
import type {
  Message,
  StreamEvent,
  TokenUsage,
  ToolDefinition,
} from "../shared/core-types.js";

// The SDK intentionally accepts this structural representation for all
// OpenAI-compatible providers, including providers with older type surfaces.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function toOpenAIMessages(messages: Message[]): any[] {
  return messages.map((message) => {
    if (typeof message.content === "string") {
      return { role: message.role, content: message.content };
    }

    const text: string[] = [];
    const toolCalls: Array<{
      id: string;
      type: "function";
      function: { name: string; arguments: string };
    }> = [];
    let toolCallId: string | undefined;
    for (const block of message.content) {
      if (block.type === "text") text.push(block.text);
      if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id,
          type: "function",
          function: { name: block.name, arguments: JSON.stringify(block.input) },
        });
        toolCallId ??= block.id;
      }
      if (block.type === "tool_result") {
        toolCallId = block.tool_use_id;
        text.push(block.content ?? "");
      }
    }
    if (toolCallId && toolCalls.length === 0) {
      return { role: "tool", content: text.join("\n"), tool_call_id: toolCallId };
    }
    if (toolCalls.length > 0) {
      return { role: "assistant", content: text.join("\n"), tool_calls: toolCalls };
    }
    return { role: message.role, content: text.join("\n") };
  });
}

export function toOpenAITools(
  tools: ToolDefinition[],
): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return tools.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema as Record<string, unknown>,
    },
  }));
}

export async function* streamOpenAIChunks(
  stream: AsyncIterable<unknown>,
): AsyncIterable<StreamEvent> {
  let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  const calls = new Map<number, {
    id: string;
    name: string;
    partialJson: string;
    started: boolean;
  }>();

  for await (const rawChunk of stream) {
    const chunk = rawChunk as Record<string, unknown>;
    const rawUsage = chunk.usage as Record<string, number | undefined> | undefined;
    if (rawUsage) {
      usage = {
        inputTokens: rawUsage.prompt_tokens ?? 0,
        outputTokens: rawUsage.completion_tokens ?? 0,
      };
    }
    const choice = (chunk.choices as Array<Record<string, unknown>> | undefined)?.[0];
    const delta = choice?.delta as Record<string, unknown> | undefined;
    if (!delta) continue;

    if (typeof delta.reasoning_content === "string") {
      yield { type: "thinking_delta", text: delta.reasoning_content };
    }
    if (typeof delta.content === "string" && delta.content) {
      yield { type: "text_delta", text: delta.content };
    }

    const toolCalls = delta.tool_calls as Array<Record<string, unknown>> | undefined;
    for (const toolCall of toolCalls ?? []) {
      const index = Number(toolCall.index);
      const fn = toolCall.function as Record<string, unknown> | undefined;
      let call = calls.get(index);
      if (typeof toolCall.id === "string") {
        call = {
          id: toolCall.id,
          name: typeof fn?.name === "string" ? fn.name : "",
          partialJson: "",
          started: false,
        };
        calls.set(index, call);
      }
      if (!call) continue;
      if (!call.name && typeof fn?.name === "string") call.name = fn.name;
      if (!call.started && call.name) {
        call.started = true;
        yield { type: "tool_use_start", id: call.id, name: call.name };
      }
      if (typeof fn?.arguments === "string" && fn.arguments) {
        call.partialJson += fn.arguments;
        yield { type: "tool_use_delta", id: call.id, partialJson: fn.arguments };
      }
    }

    const finishReason = choice?.finish_reason;
    if (typeof finishReason !== "string" || !finishReason) continue;
    for (const call of calls.values()) {
      if (!call.started) continue;
      let input: Record<string, unknown>;
      try {
        input = JSON.parse(call.partialJson) as Record<string, unknown>;
      } catch {
        input = { _incomplete: true, _raw: call.partialJson };
      }
      yield { type: "tool_use_end", id: call.id, input };
    }
    calls.clear();
    const stopReason = finishReason === "tool_calls"
      ? "tool_use"
      : finishReason === "stop"
        ? "end_turn"
        : "max_tokens";
    yield { type: "message_stop", stopReason, usage };
  }
}
