// Model layer tests
import { describe, it, expect } from "vitest";
import { createProvider } from "../src/model/router.js";
import type { AgentConfig } from "../src/shared/core-types.js";
import {
  streamOpenAIChunks,
  toOpenAIMessages,
  toOpenAITools,
} from "../src/model/openai-wire.js";

describe("Model Router", () => {
  function config(provider: string, baseURL?: string): AgentConfig["model"] {
    return { provider, model: "test-model", baseURL };
  }

  it("creates DeepSeek provider", () => {
    const p = createProvider(config("deepseek"));
    expect(p.name).toBe("deepseek");
    expect(p.supportsPromptCaching()).toBe(false);
  });

  it("creates Anthropic provider", () => {
    const p = createProvider(config("anthropic"));
    expect(p.name).toBe("anthropic");
    expect(p.supportsPromptCaching()).toBe(true);
  });

  it("creates OpenAI provider", () => {
    const p = createProvider(config("openai"));
    expect(p.name).toBe("openai");
  });

  it("creates Groq provider with known baseURL", () => {
    const p = createProvider(config("groq"));
    expect(p.name).toBe("groq");
  });

  it("creates Ollama provider with known baseURL", () => {
    const p = createProvider(config("ollama"));
    expect(p.name).toBe("ollama");
  });

  it("creates custom provider with explicit baseURL", () => {
    const p = createProvider(config("custom", "https://my-api.example.com/v1"));
    expect(p.name).toBe("custom");
  });

  it("throws for unknown provider without baseURL", () => {
    expect(() => createProvider(config("unknown-provider"))).toThrow(
      "Unknown provider"
    );
  });

  it("supports case-insensitive provider names", () => {
    const p = createProvider(config("DEEPSEEK"));
    expect(p.name).toBe("deepseek");
  });
});

describe("shared OpenAI wire protocol", () => {
  it("converts messages and tool schemas once for every compatible provider", () => {
    expect(toOpenAIMessages([{
      role: "assistant",
      content: [{ type: "tool_use", id: "call-1", name: "Read", input: { file: "a" } }],
    }])[0]).toMatchObject({
      role: "assistant",
      tool_calls: [{ function: { name: "Read", arguments: '{"file":"a"}' } }],
    });
    expect(toOpenAITools([{
      name: "Read",
      description: "read",
      type: "read",
      inputSchema: { type: "object", properties: {} },
      handler: async () => ({ content: "ok" }),
    }])[0]).toMatchObject({ function: { name: "Read" } });
  });

  it("accumulates streamed tool arguments without duplicating the first chunk", async () => {
    async function* chunks(): AsyncIterable<unknown> {
      yield {
        choices: [{ delta: { tool_calls: [{
          index: 0,
          id: "call-1",
          function: { name: "Read", arguments: '{"file"' },
        }] }, finish_reason: null }],
      };
      yield {
        choices: [{ delta: { tool_calls: [{
          index: 0,
          function: { arguments: ':"a"}' },
        }] }, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 3, completion_tokens: 2 },
      };
    }
    const events = [];
    for await (const event of streamOpenAIChunks(chunks())) events.push(event);
    expect(events).toContainEqual({ type: "tool_use_end", id: "call-1", input: { file: "a" } });
    expect(events.at(-1)).toMatchObject({
      type: "message_stop",
      stopReason: "tool_use",
      usage: { inputTokens: 3, outputTokens: 2 },
    });
  });
});

describe("DeepSeekProvider countTokens", () => {
  it("estimates tokens based on character count", async () => {
    const { DeepSeekProvider } = await import("../src/model/deepseek.js");
    const provider = new DeepSeekProvider("sk-test");

    const tokens = await provider.countTokens(
      [
        { role: "user", content: "Hello world" },
        { role: "assistant", content: "Hi there" },
      ],
      "You are a helpful assistant"
    );

    // Rough estimate should be > 0
    expect(tokens).toBeGreaterThan(0);
  });

  it("handles content blocks", async () => {
    const { DeepSeekProvider } = await import("../src/model/deepseek.js");
    const provider = new DeepSeekProvider("sk-test");

    const tokens = await provider.countTokens(
      [
        {
          role: "user",
          content: [
            { type: "text", text: "Hello" },
            {
              type: "tool_result",
              tool_use_id: "1",
              content: "file content here",
            },
          ],
        },
      ],
      ""
    );

    expect(tokens).toBeGreaterThan(0);
  });
});
