import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { projectMemoryId } from "../src/memory-files/paths.js";
import type { AgentConfig, StreamRenderer, ToolDefinition } from "../src/shared/core-types.js";

const fakeProvider = vi.hoisted(() => ({
  name: "test",
  chat: vi.fn(),
  supportsPromptCaching: vi.fn(() => false),
  countTokens: vi.fn(async () => 1),
}));
const learnFromStoredSessionRecords = vi.hoisted(() => vi.fn(() => ({
  observed: 0,
  duplicates: 0,
  candidates: [],
  publishedReleaseIds: [],
  needsReview: 0,
  skipped: [],
})));

vi.mock("../src/model/router.js", () => ({ createProvider: () => fakeProvider }));
vi.mock("../src/runtime/context-assembler.js", () => ({
  assembleContext: vi.fn(async () => ({ systemPrompt: "system", systemTokens: 1 })),
}));
vi.mock("../src/memory-files/runtime.js", () => ({ learnFromStoredSessionRecords }));
vi.mock("../src/tools/git/hooks.js", () => ({
  sessionEndHook: vi.fn(async () => ({ advice: [] })),
  prePushHook: vi.fn(async () => null),
}));

const renderer: StreamRenderer = {
  renderUserMessage() {}, renderAssistantMessage() {}, renderThinking() {},
  renderSystemMessage() {}, renderToolUse() {}, renderToolResult() {},
  renderError() {}, renderWarning() {}, clear() {}, flush() {},
};
const config: AgentConfig = {
  model: { provider: "test", model: "test-model", baseURL: "http://example.invalid" },
  permissions: { bash: "auto", read: "auto", write: "auto", edit: "auto", web: "auto" },
  session: { cleanupPeriodDays: 30 },
};

describe("agentLoop lifecycle", () => {
  let previousHome: string | undefined;
  let homeDir: string;

  beforeEach(() => {
    previousHome = process.env.HOME;
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "rubato-agent-loop-"));
    process.env.HOME = homeDir;
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it("finalizes interrupted sessions before one done event", async () => {
    const abortError = new Error("aborted");
    abortError.name = "AbortError";
    fakeProvider.chat.mockImplementation(async function* () { throw abortError; });
    const updates: Array<{ id: string; updates: Record<string, unknown> }> = [];
    const sessionManager = {
      getProjectHash: () => "c".repeat(64),
      updateSession: (id: string, update: Record<string, unknown>) => {
        updates.push({ id, updates: update });
      },
    };
    const { agentLoop } = await import("../src/agent/loop.js");
    const events = [];
    for await (const event of agentLoop({
      config,
      workingDir: homeDir,
      prompt: "hello",
      renderer,
      tools: [],
      sessionId: "lifecycle-session",
      sessionManager: sessionManager as never,
      maxTurns: 1,
    })) events.push(event);
    expect(events.filter((event) => event.type === "done"))
      .toEqual([{ type: "done", reason: "user_interrupt" }]);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ id: "lifecycle-session", updates: { status: "ended" } });
    expect(learnFromStoredSessionRecords).toHaveBeenCalled();
  });

  it("closes the hash-chained session without a database side channel", async () => {
    fakeProvider.chat.mockImplementation(async function* () {
      yield { type: "text_delta" as const, text: "A complete answer" };
      yield {
        type: "message_stop" as const,
        stopReason: "end_turn" as const,
        usage: { inputTokens: 1, outputTokens: 3 },
      };
    });
    const { agentLoop } = await import("../src/agent/loop.js");
    for await (const _event of agentLoop({
      config,
      workingDir: homeDir,
      prompt: "hello",
      renderer,
      tools: [],
      sessionId: "answered-session",
      maxTurns: 1,
    })) { /* drain */ }
    const records = fs.readFileSync(path.join(
      homeDir,
      ".rubato",
      "projects",
      projectMemoryId(homeDir),
      "sessions",
      "answered-session.jsonl",
    ), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(records).toContainEqual(expect.objectContaining({
      type: "message",
      data: { role: "user", content: "hello" },
    }));
    expect(records.at(-1)).toEqual(expect.objectContaining({ type: "session_closed" }));
  });

  it("lets the root decide whether ordinary exploration needs delegation", async () => {
    const handler = vi.fn(async () => ({ content: "background report" }));
    const tool: ToolDefinition = {
      name: "Subagent",
      description: "dispatch",
      inputSchema: { type: "object", properties: {} },
      type: "read",
      handler,
    };
    fakeProvider.chat.mockImplementation(async function* () {
      yield { type: "text_delta" as const, text: "root-owned exploration" };
      yield {
        type: "message_stop" as const,
        stopReason: "end_turn" as const,
        usage: { inputTokens: 1, outputTokens: 3 },
      };
    });
    const { agentLoop } = await import("../src/agent/loop.js");
    const events = [];
    for await (const event of agentLoop({
      config,
      workingDir: homeDir,
      prompt: "探索一下这个项目并评价架构",
      renderer,
      tools: [tool],
      sessionId: "delegation-session",
      maxTurns: 1,
    })) events.push(event);
    expect(handler).not.toHaveBeenCalled();
    expect(events).toContainEqual({ type: "text", text: "root-owned exploration" });
  });

  it("runtime-blocks serial exploration when parallel multi-scope work is explicit", async () => {
    const handler = vi.fn(async () => ({ content: "serial" }));
    const tool: ToolDefinition = {
      name: "Glob",
      description: "glob",
      inputSchema: { type: "object", properties: {} },
      type: "read",
      requiresApproval: false,
      isConcurrencySafe: true,
      handler,
    };
    fakeProvider.chat.mockImplementation(async function* () {
      yield { type: "tool_use_start" as const, id: "glob", name: "Glob" };
      yield { type: "tool_use_end" as const, id: "glob", input: {} };
      yield {
        type: "message_stop" as const,
        stopReason: "tool_use" as const,
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    });
    const { agentLoop } = await import("../src/agent/loop.js");
    const events = [];
    for await (const event of agentLoop({
      config,
      workingDir: homeDir,
      prompt: "并行探索这个目录下所有项目",
      renderer,
      tools: [tool],
      sessionId: "parallel-gate-session",
      maxTurns: 1,
    })) events.push(event);
    expect(handler).not.toHaveBeenCalled();
    expect(events).toContainEqual(expect.objectContaining({
      type: "tool_result",
      name: "Glob",
      isError: true,
      result: expect.stringContaining("delegation gate"),
    }));
  });

  it("wakes an idle root call when a background task reaches terminal state", async () => {
    const rootSessionId = "background-wake-session";
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let rootCalls = 0;
    let wakeMessages: unknown;
    let wakeSystem = "";
    fakeProvider.chat.mockImplementation(async function* (params) {
      const firstMessage = JSON.stringify(params.messages[0]);
      if (firstMessage.includes("Task: research")) {
        await gate;
        yield { type: "text_delta" as const, text: "private report evidence" };
        yield {
          type: "message_stop" as const,
          stopReason: "end_turn" as const,
          usage: { inputTokens: 2, outputTokens: 2 },
        };
        return;
      }
      rootCalls++;
      if (rootCalls === 1) {
        yield { type: "text_delta" as const, text: "Initial answer." };
        yield {
          type: "message_stop" as const,
          stopReason: "end_turn" as const,
          usage: { inputTokens: 1, outputTokens: 2 },
        };
        setTimeout(release, 5);
      } else {
        wakeMessages = structuredClone(params.messages);
        wakeSystem = params.system;
        yield { type: "text_delta" as const, text: "Wake response." };
        yield {
          type: "message_stop" as const,
          stopReason: "end_turn" as const,
          usage: { inputTokens: 2, outputTokens: 2 },
        };
      }
    });

    const { GENERAL_DEF, resolveSubagentTools } = await import("../src/agent/subagent.js");
    const { processSubagentRegistry } = await import("../src/agent/subagents/registry.js");
    const runtime = processSubagentRegistry.getOrCreate(rootSessionId, homeDir, config);
    runtime.submit({
      description: "research",
      prompt: "find supplementary evidence",
      timeout_ms: 60_000,
    }, {
      workingDir: homeDir,
      sessionId: rootSessionId,
      readGuard: { hasRead: () => false, markAsRead: () => {}, serialize: () => ({ files: {} }) },
      permissionManager: { check: () => ({ allowed: true }) },
      config,
      mode: "default",
      depth: 0,
    }, GENERAL_DEF, resolveSubagentTools(GENERAL_DEF));

    let inputCalls = 0;
    const events = [];
    try {
      const { agentLoop } = await import("../src/agent/loop.js");
      for await (const event of agentLoop({
        config,
        workingDir: homeDir,
        prompt: "answer now and supplement later",
        renderer,
        tools: [],
        sessionId: rootSessionId,
        maxTurns: 3,
        getNextUserMessage: async (signal) => {
          inputCalls++;
          if (inputCalls > 1) return null;
          return new Promise((resolve) => {
            signal?.addEventListener("abort", () => resolve(null), { once: true });
          });
        },
      })) events.push(event);
    } finally {
      processSubagentRegistry.remove(rootSessionId, true);
    }

    expect(events).toContainEqual({ type: "text", text: "Initial answer." });
    expect(events).toContainEqual({ type: "text", text: "Wake response." });
    expect(JSON.stringify(wakeMessages)).toContain("Runtime notification");
    expect(JSON.stringify(wakeMessages)).toContain("Report:");
    expect(JSON.stringify(wakeMessages)).not.toContain("private report evidence");
    expect(wakeSystem).toContain("status: finished");
    const traceEvents = fs.readFileSync(runtime.artifacts.tracePath, "utf8")
      .trim().split("\n").map((line) => JSON.parse(line));
    expect(traceEvents.some((event) => event.type === "parent_wake")).toBe(true);
  });
});
