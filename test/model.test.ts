// Model layer tests
import { describe, it, expect } from "vitest";
import { createProvider } from "../src/model/router.js";
import type { AgentConfig } from "../src/core-types.js";

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
