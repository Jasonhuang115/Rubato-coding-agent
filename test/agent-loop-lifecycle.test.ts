// Agent loop lifecycle tests — done events must follow finalization.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import type { AgentConfig, ModelProvider, StreamRenderer, ToolDefinition } from "../src/shared/core-types.js";

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

vi.mock("../src/model/router.js", () => ({
  createProvider: () => fakeProvider,
}));

vi.mock("../src/runtime/context-assembler.js", () => ({
  assembleContext: vi.fn(async () => ({ systemPrompt: "system", systemTokens: 1 })),
}));

vi.mock("../src/memory-files/runtime.js", () => ({
  learnFromStoredSessionRecords,
}));

vi.mock("../src/tools/git/hooks.js", () => ({
  sessionEndHook: vi.fn(async () => ({ advice: [] })),
  prePushHook: vi.fn(async () => null),
  preCommitHook: vi.fn(async () => null),
}));

const renderer: StreamRenderer = {
  renderUserMessage: () => {},
  renderAssistantMessage: () => {},
  renderThinking: () => {},
  renderSystemMessage: () => {},
  renderToolUse: () => {},
  renderToolResult: () => {},
  renderError: () => {},
  renderWarning: () => {},
  clear: () => {},
  flush: () => {},
};

const config: AgentConfig = {
  model: { provider: "test", model: "test-model", baseURL: "http://example.invalid" },
  permissions: {
    bash: "auto",
    read: "auto",
    write: "auto",
    edit: "auto",
    web: "auto",
  },
  embedding: { source: "local_hash" },
  mnemosyne: { bootstrap_on_first_open: false, bootstrap_max_files: 100 },
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
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it("finalizes interrupted sessions before emitting a single done event", async () => {
    const abortError = new Error("aborted");
    abortError.name = "AbortError";
    fakeProvider.chat.mockImplementation(async function* () {
      throw abortError;
    });

    const updates: Array<{ id: string; updates: Record<string, unknown> }> = [];
    const sessionManager = {
      getProjectHash: () => "test-project",
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
    })) {
      events.push(event);
    }

    const doneEvents = events.filter((event) => event.type === "done");
    expect(doneEvents).toEqual([{ type: "done", reason: "user_interrupt" }]);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      id: "lifecycle-session",
      updates: { status: "ended" },
    });
    expect(learnFromStoredSessionRecords).toHaveBeenCalled();
    expect(learnFromStoredSessionRecords.mock.calls.at(-1)?.[1])
      .toMatchObject({ sessionId: "lifecycle-session" });
  });

  it("closes the hash-chained session without a database memory side channel", async () => {
    fakeProvider.chat.mockImplementation(async function* () {
      yield { type: "text_delta" as const, text: "A complete answer" };
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
      prompt: "hello",
      renderer,
      tools: [],
      sessionId: "answered-session",
      maxTurns: 1,
    })) {
      events.push(event);
    }

    expect(events).toContainEqual({ type: "text", text: "A complete answer" });
    expect(learnFromStoredSessionRecords).toHaveBeenCalled();
    const records = fs.readFileSync(
      path.join(homeDir, ".rubato", "sessions", "answered-session.jsonl"),
      "utf8",
    ).trim().split("\n").map((line) => JSON.parse(line));
    expect(records).toContainEqual(expect.objectContaining({
      type: "message",
      data: { role: "user", content: "hello" },
    }));
    expect(records).toContainEqual(expect.objectContaining({
      type: "message",
      data: expect.objectContaining({ role: "assistant" }),
    }));
    expect(records.at(-1)).toEqual(expect.objectContaining({
      type: "session_closed",
    }));
  });

  it("lets the root model decide whether broad exploration needs delegation", async () => {
    const agentHandler = vi.fn(async () => ({ content: "exploration report" }));
    const agentTool: ToolDefinition = {
      name: "Agent",
      description: "delegate work",
      inputSchema: { type: "object", properties: {} },
      type: "write",
      handler: agentHandler,
    };
    const { register, clear } = await import("../src/tools/registry.js");
    clear();
    register(agentTool);

    let modelMessages: unknown;
    fakeProvider.chat.mockImplementation(async function* (params) {
      modelMessages = structuredClone(params.messages);
      yield { type: "text_delta" as const, text: "root-owned exploration" };
      yield {
        type: "message_stop" as const,
        stopReason: "end_turn" as const,
        usage: { inputTokens: 1, outputTokens: 3 },
      };
    });

    try {
      const { agentLoop } = await import("../src/agent/loop.js");
      const events = [];
      for await (const event of agentLoop({
        config,
        workingDir: homeDir,
        prompt: "探索一下这个项目并评价架构，不要进行改动",
        renderer,
        tools: [agentTool],
        sessionId: "delegation-session",
        maxTurns: 1,
      })) {
        events.push(event);
      }

      expect(agentHandler).not.toHaveBeenCalled();
      expect(events).toContainEqual({ type: "text", text: "root-owned exploration" });
      expect(modelMessages).toEqual([{
        role: "user",
        content: "探索一下这个项目并评价架构，不要进行改动",
      }]);
    } finally {
      clear();
    }
  });

  it("runtime-blocks serial broad exploration when the user explicitly requires parallel multi-project work", async () => {
    const globHandler = vi.fn(async () => ({ content: "serial exploration" }));
    const globTool: ToolDefinition = {
      name: "Glob",
      description: "broad discovery",
      inputSchema: { type: "object", properties: {} },
      type: "read",
      requiresApproval: false,
      isConcurrencySafe: true,
      handler: globHandler,
    };
    fakeProvider.chat.mockImplementation(async function* () {
      yield { type: "tool_use_start" as const, id: "glob-serial", name: "Glob" };
      yield {
        type: "tool_use_end" as const,
        id: "glob-serial",
        input: { pattern: "**/*", path: homeDir },
      };
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
      tools: [globTool],
      sessionId: "parallel-gate-session",
      maxTurns: 1,
    })) {
      events.push(event);
    }

    expect(globHandler).not.toHaveBeenCalled();
    expect(events).toContainEqual(expect.objectContaining({
      type: "tool_result",
      name: "Glob",
      isError: true,
      result: expect.stringContaining("delegation gate"),
    }));
  });

  it("stops immediately after CompleteTask control without another model turn", async () => {
    const trailingRead = vi.fn(async () => ({ content: "should not run" }));
    fakeProvider.chat.mockImplementation(async function* () {
      yield { type: "tool_use_start" as const, id: "complete-1", name: "CompleteTask" };
      yield {
        type: "tool_use_end" as const,
        id: "complete-1",
        input: {
          status: "completed",
          summary: "done",
          report_markdown: "# Done\n\nEvidence collected.",
        },
      };
      yield { type: "tool_use_start" as const, id: "read-after", name: "Read" };
      yield {
        type: "tool_use_end" as const,
        id: "read-after",
        input: { file_path: "/tmp/should-not-run" },
      };
      yield {
        type: "message_stop" as const,
        stopReason: "tool_use" as const,
        usage: { inputTokens: 3, outputTokens: 2 },
      };
    });
    const { completeTaskTool } = await import("../src/tools/complete-task.js");
    const readAfterTool: ToolDefinition = {
      name: "Read",
      description: "trailing read",
      inputSchema: { type: "object", properties: {} },
      type: "read",
      isConcurrencySafe: true,
      handler: trailingRead,
    };
    const { agentLoop } = await import("../src/agent/loop.js");
    const events = [];
    for await (const event of agentLoop({
      config,
      workingDir: homeDir,
      prompt: "complete this",
      renderer,
      tools: [completeTaskTool, readAfterTool],
      sessionId: "complete-task-session",
      contextProfile: "subagent",
      roleSystemPrompt: "read-only verifier",
      taskRuntime: {
        rootSessionId: "root",
        taskId: "task",
        agentId: "agent",
        depth: 1,
        completionSubmitted: false,
      },
    })) {
      events.push(event);
    }

    expect(fakeProvider.chat).toHaveBeenCalledOnce();
    expect(trailingRead).not.toHaveBeenCalled();
    expect(events).toContainEqual({
      type: "task_completion",
      completion: {
        status: "completed",
        summary: "done",
        report_markdown: "# Done\n\nEvidence collected.",
      },
    });
    expect(events).not.toContainEqual(expect.objectContaining({
      type: "tool_result",
      name: "CompleteTask",
    }));
    expect(events).toContainEqual({ type: "done", reason: "task_completion" });
  });

  it("preserves context and forces one CompleteTask turn after an ordinary end_turn", async () => {
    let calls = 0;
    let finalizationMessages: unknown;
    fakeProvider.chat.mockImplementation(async function* (params) {
      calls++;
      if (calls === 1) {
        yield {
          type: "text_delta" as const,
          text: "I have gathered the evidence. Let me compile it.",
        };
        yield {
          type: "message_stop" as const,
          stopReason: "end_turn" as const,
          usage: { inputTokens: 3, outputTokens: 2 },
        };
        return;
      }
      finalizationMessages = structuredClone(params.messages);
      expect(params.tools.map((tool) => tool.name)).toEqual(["CompleteTask"]);
      yield { type: "tool_use_start" as const, id: "complete-retry", name: "CompleteTask" };
      yield {
        type: "tool_use_end" as const,
        id: "complete-retry",
        input: {
          status: "partial",
          summary: "Recovered the gathered evidence.",
          report_markdown: "# Recovered\n\nEvidence from the first turn.",
        },
      };
      yield {
        type: "message_stop" as const,
        stopReason: "tool_use" as const,
        usage: { inputTokens: 5, outputTokens: 3 },
      };
    });

    const { completeTaskTool } = await import("../src/tools/complete-task.js");
    const { agentLoop } = await import("../src/agent/loop.js");
    const events = [];
    for await (const event of agentLoop({
      config,
      workingDir: homeDir,
      prompt: "investigate",
      renderer,
      tools: [completeTaskTool],
      sessionId: "forced-completion-session",
      contextProfile: "subagent",
      roleSystemPrompt: "read-only investigator",
      taskRuntime: {
        rootSessionId: "root",
        taskId: "task",
        agentId: "agent",
        depth: 1,
        completionSubmitted: false,
      },
    })) {
      events.push(event);
    }

    expect(calls).toBe(2);
    expect(events).toContainEqual({ type: "completion_retry", attempt: 1 });
    expect(events).toContainEqual(expect.objectContaining({ type: "task_completion" }));
    expect(JSON.stringify(finalizationMessages)).toContain("Runtime completion required");
    expect(JSON.stringify(finalizationMessages)).toContain("Let me compile it");
  });

  it("reserves a finalization turn when maxTurns is reached after tool use", async () => {
    let calls = 0;
    fakeProvider.chat.mockImplementation(async function* () {
      calls++;
      if (calls === 1) {
        yield { type: "tool_use_start" as const, id: "read-1", name: "Read" };
        yield {
          type: "tool_use_end" as const,
          id: "read-1",
          input: { file_path: path.join(homeDir, "evidence.txt") },
        };
        yield {
          type: "message_stop" as const,
          stopReason: "tool_use" as const,
          usage: { inputTokens: 2, outputTokens: 1 },
        };
        return;
      }
      yield { type: "tool_use_start" as const, id: "complete-max", name: "CompleteTask" };
      yield {
        type: "tool_use_end" as const,
        id: "complete-max",
        input: {
          status: "partial",
          summary: "Turn-limited evidence.",
          report_markdown: "# Partial\n\nThe available evidence was preserved.",
        },
      };
      yield {
        type: "message_stop" as const,
        stopReason: "tool_use" as const,
        usage: { inputTokens: 3, outputTokens: 2 },
      };
    });
    fs.writeFileSync(path.join(homeDir, "evidence.txt"), "evidence\n");
    const { completeTaskTool } = await import("../src/tools/complete-task.js");
    const { readTool } = await import("../src/tools/read.js");
    const { agentLoop } = await import("../src/agent/loop.js");
    const events = [];
    for await (const event of agentLoop({
      config,
      workingDir: homeDir,
      prompt: "inspect within one working turn",
      renderer,
      tools: [readTool, completeTaskTool],
      sessionId: "max-turn-completion-session",
      contextProfile: "subagent",
      roleSystemPrompt: "read-only investigator",
      maxTurns: 1,
      taskRuntime: {
        rootSessionId: "root",
        taskId: "task",
        agentId: "agent",
        depth: 1,
        completionSubmitted: false,
      },
    })) {
      events.push(event);
    }

    expect(calls).toBe(2);
    expect(events).toContainEqual({ type: "completion_retry", attempt: 1 });
    expect(events).toContainEqual({ type: "done", reason: "task_completion" });
  });

  it("wakes an idle root loop when an advisory task completes", async () => {
    const rootSessionId = "advisory-wake-session";
    let releaseSubagent!: () => void;
    const subagentGate = new Promise<void>((resolve) => { releaseSubagent = resolve; });
    let rootCalls = 0;
    let supplementalMessages: unknown;
    fakeProvider.chat.mockImplementation(async function* (params) {
      if (params.tools.some((tool) => tool.name === "CompleteTask")) {
        await subagentGate;
        yield { type: "tool_use_start" as const, id: "complete-bg", name: "CompleteTask" };
        yield {
          type: "tool_use_end" as const,
          id: "complete-bg",
          input: {
            status: "completed",
            summary: "Background research ready.",
            report_markdown: "# Research\n\nNew evidence.",
          },
        };
        yield {
          type: "message_stop" as const,
          stopReason: "tool_use" as const,
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
        setTimeout(releaseSubagent, 5);
      } else {
        supplementalMessages = structuredClone(params.messages);
        yield { type: "text_delta" as const, text: "Supplemental answer." };
        yield {
          type: "message_stop" as const,
          stopReason: "end_turn" as const,
          usage: { inputTokens: 2, outputTokens: 2 },
        };
      }
    });

    const { completeTaskTool } = await import("../src/tools/complete-task.js");
    const { processSubagentRegistry } = await import("../src/agent/subagents/registry.js");
    const runtime = processSubagentRegistry.getOrCreate(rootSessionId, homeDir, config);
    const parentCtx = {
      workingDir: homeDir,
      sessionId: rootSessionId,
      readGuard: { hasRead: () => false, markAsRead: () => {}, serialize: () => ({ files: {} }) },
      permissionManager: { check: () => ({ allowed: true }) },
      config,
      depth: 0,
    };
    runtime.submit({
      description: "research",
      prompt: "find supplementary evidence",
      dependency: "advisory",
    }, parentCtx, {
      name: "research",
      description: "research",
      systemPrompt: "readonly researcher",
      tools: [],
      readonly: true,
    }, [completeTaskTool]);

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
      })) {
        events.push(event);
      }
    } finally {
      processSubagentRegistry.remove(rootSessionId, true);
    }

    expect(events).toContainEqual({ type: "text", text: "Initial answer." });
    expect(events).toContainEqual({ type: "text", text: "Supplemental answer." });
    expect(JSON.stringify(supplementalMessages)).toContain("Background research ready.");
    expect(JSON.stringify(supplementalMessages)).toContain("Report:");
    const traceEvents = fs.readFileSync(runtime.artifacts.tracePath, "utf8")
      .trim().split("\n").map((line) => JSON.parse(line));
    expect(traceEvents.some((event) => event.type === "root_turn_completed")).toBe(true);
    expect(traceEvents.some((event) => event.type === "task_queued")).toBe(true);
    expect(traceEvents.some((event) => event.type === "task_terminal")).toBe(true);
    expect(traceEvents.some((event) => event.type === "parent_wake")).toBe(true);
  });

  it("does not wake the root again after Task wait manually joins an advisory result", async () => {
    const rootSessionId = "advisory-manual-join-session";
    let rootCalls = 0;
    let taskId = "";
    fakeProvider.chat.mockImplementation(async function* (params) {
      if (params.tools.some((tool) => tool.name === "CompleteTask")) {
        yield { type: "tool_use_start" as const, id: "complete-bg", name: "CompleteTask" };
        yield {
          type: "tool_use_end" as const,
          id: "complete-bg",
          input: {
            status: "completed",
            summary: "Joined research ready.",
            report_markdown: "# Joined research\n\nEvidence.",
          },
        };
        yield {
          type: "message_stop" as const,
          stopReason: "tool_use" as const,
          usage: { inputTokens: 2, outputTokens: 2 },
        };
        return;
      }
      rootCalls++;
      if (rootCalls === 1) {
        yield { type: "tool_use_start" as const, id: "wait-bg", name: "Task" };
        yield {
          type: "tool_use_end" as const,
          id: "wait-bg",
          input: { action: "wait", task_id: taskId },
        };
        yield {
          type: "message_stop" as const,
          stopReason: "tool_use" as const,
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      } else {
        yield { type: "text_delta" as const, text: "Final answer with joined evidence." };
        yield {
          type: "message_stop" as const,
          stopReason: "end_turn" as const,
          usage: { inputTokens: 2, outputTokens: 2 },
        };
      }
    });

    const { completeTaskTool } = await import("../src/tools/complete-task.js");
    const { taskTool } = await import("../src/tools/task.js");
    const { processSubagentRegistry } = await import("../src/agent/subagents/registry.js");
    const runtime = processSubagentRegistry.getOrCreate(rootSessionId, homeDir, config);
    const submitted = runtime.submit({
      description: "research to join",
      prompt: "collect evidence",
      dependency: "advisory",
    }, {
      workingDir: homeDir,
      sessionId: rootSessionId,
      readGuard: { hasRead: () => false, markAsRead: () => {}, serialize: () => ({ files: {} }) },
      permissionManager: { check: () => ({ allowed: true }) },
      config,
      depth: 0,
    }, {
      name: "research",
      description: "research",
      systemPrompt: "readonly researcher",
      tools: [],
      readonly: true,
    }, [completeTaskTool]);
    taskId = submitted.task.taskId;

    const events = [];
    try {
      const { agentLoop } = await import("../src/agent/loop.js");
      for await (const event of agentLoop({
        config,
        workingDir: homeDir,
        prompt: "join the background research before answering",
        renderer,
        tools: [taskTool],
        sessionId: rootSessionId,
        maxTurns: 3,
      })) {
        events.push(event);
      }
    } finally {
      processSubagentRegistry.remove(rootSessionId, true);
    }

    expect(rootCalls).toBe(2);
    expect(events).toContainEqual({ type: "text", text: "Final answer with joined evidence." });
    const traceEvents = fs.readFileSync(runtime.artifacts.tracePath, "utf8")
      .trim().split("\n").map((line) => JSON.parse(line));
    expect(traceEvents).toContainEqual(expect.objectContaining({
      type: "task_wait_started",
      taskId,
    }));
    expect(traceEvents).toContainEqual(expect.objectContaining({
      type: "task_wait_completed",
      taskId,
      outcome: "result",
    }));
    expect(traceEvents.some((event) => event.type === "parent_wake")).toBe(false);
  });

  it("lets only the root read a report, modify code, and run verification", async () => {
    const targetPath = path.join(homeDir, "target.txt");
    fs.writeFileSync(targetPath, "old\n");
    const reportPath = path.join(
      homeDir,
      ".rubato",
      "projects",
      "project",
      "runs",
      "prior-session",
      "tasks",
      "task-report",
      "report.md",
    );
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, "# Recommendation\n\nChange target.txt to `updated`.");
    let call = 0;
    fakeProvider.chat.mockImplementation(async function* () {
      call++;
      if (call === 1) {
        yield { type: "tool_use_start" as const, id: "read-report", name: "Read" };
        yield { type: "tool_use_end" as const, id: "read-report", input: { file_path: reportPath } };
        yield { type: "tool_use_start" as const, id: "read-target", name: "Read" };
        yield { type: "tool_use_end" as const, id: "read-target", input: { file_path: targetPath } };
        yield {
          type: "message_stop" as const,
          stopReason: "tool_use" as const,
          usage: { inputTokens: 2, outputTokens: 2 },
        };
      } else if (call === 2) {
        yield { type: "tool_use_start" as const, id: "write-target", name: "Write" };
        yield {
          type: "tool_use_end" as const,
          id: "write-target",
          input: { file_path: targetPath, content: "updated\n" },
        };
        yield {
          type: "message_stop" as const,
          stopReason: "tool_use" as const,
          usage: { inputTokens: 2, outputTokens: 2 },
        };
      } else if (call === 3) {
        yield { type: "tool_use_start" as const, id: "verify-target", name: "Bash" };
        yield {
          type: "tool_use_end" as const,
          id: "verify-target",
          input: {
            command: `grep -qx updated ${targetPath}`,
          },
        };
        yield {
          type: "message_stop" as const,
          stopReason: "tool_use" as const,
          usage: { inputTokens: 2, outputTokens: 2 },
        };
      } else {
        yield { type: "text_delta" as const, text: "Implemented and verified." };
        yield {
          type: "message_stop" as const,
          stopReason: "end_turn" as const,
          usage: { inputTokens: 2, outputTokens: 2 },
        };
      }
    });

    const { readTool } = await import("../src/tools/read.js");
    const { writeTool } = await import("../src/tools/write.js");
    const { bashTool } = await import("../src/tools/bash.js");
    const { agentLoop } = await import("../src/agent/loop.js");
    const events = [];
    for await (const event of agentLoop({
      config,
      workingDir: homeDir,
      prompt: `Review ${reportPath}, implement it, and verify the change.`,
      renderer,
      tools: [readTool, writeTool, bashTool],
      sessionId: "root-writer-session",
      maxTurns: 4,
    })) {
      events.push(event);
    }

    expect(fs.readFileSync(targetPath, "utf8")).toBe("updated\n");
    expect(events).toContainEqual({ type: "text", text: "Implemented and verified." });
    expect(events).toContainEqual(expect.objectContaining({
      type: "tool_result",
      name: "Bash",
      isError: false,
    }));
  });
});
