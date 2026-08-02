import { describe, expect, it } from "vitest";
import type {
  AgentContext,
  ModelProvider,
  StreamRenderer,
} from "../src/shared/core-types.js";
import {
  executeTurn,
  StreamFailedError,
} from "../src/runtime/step-executor.js";

function renderer(): StreamRenderer {
  return {
    renderThinking() {},
    renderAssistantMessage() {},
    renderToolUse() {},
    renderToolResult() {},
    renderWarning() {},
    renderError() {},
    flush() {},
  };
}

describe("stream retry policy", () => {
  it("does not retry provider-declared non-retryable errors such as HTTP 402", async () => {
    let calls = 0;
    const provider: ModelProvider = {
      name: "test",
      async *chat() {
        calls += 1;
        yield {
          type: "error" as const,
          message: "402 Insufficient Balance",
          retryable: false,
        };
      },
    };

    const events: Array<{ type: string; message?: string; retryable?: boolean }> = [];
    const run = executeTurn({
      provider,
      model: "test",
      systemPrompt: "",
      messages: [],
      tools: [],
      renderer: renderer(),
      workingDir: process.cwd(),
      ctx: { sessionId: "test", workingDir: process.cwd() } as AgentContext,
      toolRuntime: {} as never,
      maxRetries: 3,
    });

    let thrown: unknown;
    try {
      for await (const event of run) events.push(event);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(StreamFailedError);
    expect(calls).toBe(1);
    expect(events).toContainEqual({
      type: "error",
      message: "Stream error (not retryable): 402 Insufficient Balance",
      retryable: false,
    });
    expect(events.some((event) => event.type === "warning")).toBe(false);
  });
});
