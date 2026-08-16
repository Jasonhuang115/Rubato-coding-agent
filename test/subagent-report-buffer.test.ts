import { describe, expect, it, vi } from "vitest";

vi.mock("../src/agent/loop.js", () => ({
  agentLoop: async function* (options: any) {
    yield { type: "turn_start", turn: 1 };
    options.taskRuntime.onTextDelta("early evidence");
    await new Promise((resolve) => setTimeout(resolve, 120));
    options.taskRuntime.onTextDelta("x".repeat(4_096));
    yield { type: "tool_call", id: "tool-1", name: "Read", input: {} };
    yield {
      type: "tool_result",
      id: "tool-1",
      name: "Read",
      result: "raw tool output must not be copied",
      isError: false,
    };
    yield { type: "error", message: "temporary stream break", retryable: true };
    yield { type: "turn_end", turn: 1, usage: { input: 1, output: 2 } };
    yield { type: "done", reason: "end_turn" };
  },
  abortCurrentRequest() {},
}));

import { GENERAL_DEF } from "../src/agent/subagent.js";
import { TaskRunner } from "../src/agent/subagents/task-runner.js";

describe("Subagent incremental report buffering", () => {
  it("flushes by time, size, and boundaries without copying tool results", async () => {
    const chunks: string[] = [];
    const runner = new TaskRunner();
    const result = await runner.run({
      rootSessionId: "root",
      taskId: "task",
      agentId: "agent",
      prompt: "inspect",
      definition: GENERAL_DEF,
      config: {
        model: { provider: "test", model: "test" },
        permissions: { bash: "auto", read: "auto", write: "auto", edit: "auto", web: "auto" },
        session: { cleanupPeriodDays: 30 },
      },
      workingDir: process.cwd(),
      tools: [],
      coverageRequired: false,
      abortSignal: new AbortController().signal,
      trace: { append: vi.fn() } as any,
      appendReport: (content) => chunks.push(content),
      onActivity: vi.fn(),
    });

    expect(result.status).toBe("finished");
    expect(chunks[0]).toBe("early evidence");
    expect(chunks.some((chunk) => chunk.length >= 4_096)).toBe(true);
    expect(chunks.join("")).toContain("Rubato stream interrupted");
    expect(chunks.join("")).not.toContain("raw tool output must not be copied");
  });
});
