import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConfig, StreamRenderer } from "../src/shared/core-types.js";
import { globTool } from "../src/tools/glob.js";
import { readTool } from "../src/tools/read.js";
import { agentTool } from "../src/tools/agent.js";
import { clear, register } from "../src/tools/registry.js";

const provider = vi.hoisted(() => ({
  name: "test",
  chat: vi.fn(),
  supportsPromptCaching: vi.fn(() => false),
  countTokens: vi.fn(async () => 1),
}));

vi.mock("../src/model/router.js", () => ({ createProvider: () => provider }));
vi.mock("../src/runtime/context-assembler.js", () => ({
  assembleContext: vi.fn(async () => ({ systemPrompt: "test system", systemTokens: 1 })),
}));
vi.mock("../src/tools/git/hooks.js", () => ({
  sessionStartHook: vi.fn(async () => null),
  conflictCheckHook: vi.fn(async () => null),
  sessionEndHook: vi.fn(async () => ({ advice: [] })),
  prePushHook: vi.fn(async () => null),
  preCommitHook: vi.fn(async () => null),
}));

const renderer: StreamRenderer = {
  renderUserMessage() {},
  renderAssistantMessage() {},
  renderThinking() {},
  renderSystemMessage() {},
  renderToolUse() {},
  renderToolResult() {},
  renderError() {},
  renderWarning() {},
  clear() {},
  flush() {},
};

const config: AgentConfig = {
  model: { provider: "test", model: "test-model", maxRetries: 0 },
  permissions: { bash: "auto", read: "auto", write: "auto", edit: "auto", web: "auto" },
  embedding: { source: "local_hash" },
  mnemosyne: { bootstrap_on_first_open: false, bootstrap_max_files: 10 },
  session: { cleanupPeriodDays: 30 },
  subagents: {
    maxConcurrent: 2,
    maxTasksPerSession: 8,
    maxDepth: 3,
    stallTimeoutMs: 60_000,
    hardTimeoutMs: 60_000,
    artifactTtlDays: 30,
    artifactSoftLimitBytes: 10_000_000,
  },
};

describe("root/subagent exhaustive exploration E2E", () => {
  let home = "";
  let previousHome: string | undefined;
  const rootSessionId = "large-exploration-e2e";

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "rubato-subagent-e2e-"));
    previousHome = process.env.HOME;
    process.env.HOME = home;
    process.env.RUBATO_HOME = path.join(home, ".rubato");
    fs.mkdirSync(path.join(home, "alpha", "src"), { recursive: true });
    fs.mkdirSync(path.join(home, "beta", "src"), { recursive: true });
    fs.writeFileSync(path.join(home, "alpha", "src", "a.ts"), "export const alpha = 1;\n");
    fs.writeFileSync(path.join(home, "beta", "src", "b.ts"), "export const beta = 2;\n");
    clear();
    register(globTool);
    register(readTool);
    register(agentTool);
    vi.clearAllMocks();
  });

  afterEach(async () => {
    const { processSubagentRegistry } = await import("../src/agent/subagents/registry.js");
    processSubagentRegistry.remove(rootSessionId, true);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    delete process.env.RUBATO_HOME;
    clear();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("splits work, closes subagent coverage, joins once, and synthesizes from artifacts", async () => {
    let rootCalls = 0;
    let subagentCalls = 0;
    let taskId = "";
    let reportPath = "";
    let coveragePath = "";
    const betaRoot = path.join(home, "beta");

    provider.chat.mockImplementation(async function* (params) {
      const isSubagent = params.tools.some((tool) => tool.name === "CompleteTask");
      if (isSubagent) {
        subagentCalls++;
        if (subagentCalls === 1) {
          yield { type: "tool_use_start" as const, id: "beta-glob", name: "Glob" };
          yield {
            type: "tool_use_end" as const,
            id: "beta-glob",
            input: { pattern: "**/*", path: betaRoot, include_hidden: true },
          };
        } else if (subagentCalls === 2) {
          yield { type: "tool_use_start" as const, id: "beta-read", name: "Read" };
          yield {
            type: "tool_use_end" as const,
            id: "beta-read",
            input: { file_path: path.join(betaRoot, "src", "b.ts") },
          };
        } else {
          yield { type: "tool_use_start" as const, id: "beta-complete", name: "CompleteTask" };
          yield {
            type: "tool_use_end" as const,
            id: "beta-complete",
            input: {
              status: "completed",
              summary: "Beta was fully inspected.",
              report_markdown:
                "# Beta report\n\n`src/b.ts` defines the exported constant `beta` with value 2.",
              key_files: [path.join(betaRoot, "src", "b.ts")],
              coverage: {
                exhaustive: true,
                scope_roots: [betaRoot],
                exclusions: [],
              },
            },
          };
        }
        yield {
          type: "message_stop" as const,
          stopReason: "tool_use" as const,
          usage: { inputTokens: 10, outputTokens: 2 },
        };
        return;
      }

      rootCalls++;
      const messages = params.messages.flatMap((message) => {
        if (typeof message.content === "string") return [message.content];
        return message.content.flatMap((block) =>
          block.type === "text" || block.type === "tool_result"
            ? [block.type === "text" ? block.text : block.content]
            : []);
      }).join("\n");
      if (rootCalls === 1) {
        yield { type: "tool_use_start" as const, id: "alpha-glob", name: "Glob" };
        yield {
          type: "tool_use_end" as const,
          id: "alpha-glob",
          input: { pattern: "**/*", path: path.join(home, "alpha"), include_hidden: true },
        };
        yield { type: "tool_use_start" as const, id: "alpha-read", name: "Read" };
        yield {
          type: "tool_use_end" as const,
          id: "alpha-read",
          input: { file_path: path.join(home, "alpha", "src", "a.ts") },
        };
        yield { type: "tool_use_start" as const, id: "spawn-beta", name: "Agent" };
        yield {
          type: "tool_use_end" as const,
          id: "spawn-beta",
          input: {
            description: "Inspect beta exhaustively",
            prompt: `Inspect every line of every source file under ${betaRoot}.`,
            subagent_type: "explore",
            dependency: "advisory",
            coverage: "exhaustive",
          },
        };
      } else if (rootCalls === 2) {
        taskId = messages.match(/Background task queued: (task-[0-9a-f-]+)/)?.[1] ?? "";
        expect(taskId).not.toBe("");
        yield { type: "tool_use_start" as const, id: "wait-beta", name: "Task" };
        yield {
          type: "tool_use_end" as const,
          id: "wait-beta",
          input: { action: "wait", task_id: taskId },
        };
      } else if (rootCalls === 3) {
        reportPath = messages.match(/"reportPath"\s*:\s*"([^"]+report\.md)"/)?.[1] ?? "";
        coveragePath = messages.match(/"coveragePath"\s*:\s*"([^"]+coverage\.json)"/)?.[1] ?? "";
        expect(reportPath).not.toBe("");
        expect(coveragePath).not.toBe("");
        yield { type: "tool_use_start" as const, id: "read-beta-report", name: "Read" };
        yield {
          type: "tool_use_end" as const,
          id: "read-beta-report",
          input: { file_path: reportPath },
        };
        yield { type: "tool_use_start" as const, id: "read-beta-coverage", name: "Read" };
        yield {
          type: "tool_use_end" as const,
          id: "read-beta-coverage",
          input: { file_path: coveragePath },
        };
      } else {
        expect(messages).toContain("Beta report");
        expect(messages).toContain("export const alpha = 1");
        yield {
          type: "text_delta" as const,
          text:
            "Alpha and Beta are complete: root inspected Alpha, the subagent inspected Beta, and Beta coverage is closed.",
        };
        yield {
          type: "message_stop" as const,
          stopReason: "end_turn" as const,
          usage: { inputTokens: 20, outputTokens: 8 },
        };
        return;
      }
      yield {
        type: "message_stop" as const,
        stopReason: "tool_use" as const,
        usage: { inputTokens: 10, outputTokens: 2 },
      };
    });

    const { taskTool } = await import("../src/tools/task.js");
    const { agentLoop } = await import("../src/agent/loop.js");
    const events = [];
    for await (const event of agentLoop({
      config,
      workingDir: home,
      prompt: "Inspect every line of every source file in alpha and beta.",
      renderer,
      tools: [agentTool, taskTool, globTool, readTool],
      sessionId: rootSessionId,
      maxTurns: 6,
    })) {
      events.push(event);
    }

    const { processSubagentRegistry } = await import("../src/agent/subagents/registry.js");
    const runtime = processSubagentRegistry.get(rootSessionId)!;
    const trace = fs.readFileSync(runtime.artifacts.tracePath, "utf8")
      .trim().split("\n").map((line) => JSON.parse(line));
    expect({
      rootCalls,
      subagentCalls,
      doneReasons: events.filter((event) => event.type === "done"),
      errors: events.filter((event) => event.type === "error"),
      rootTurns: trace.filter((event) => event.type === "root_turn_completed").length,
      parentWakes: trace.filter((event) => event.type === "parent_wake").length,
    }).toEqual({
      rootCalls: 4,
      subagentCalls: 3,
      doneReasons: [{ type: "done", reason: "end_turn" }],
      errors: [],
      rootTurns: 4,
      parentWakes: 0,
    });
    expect(events).toContainEqual(expect.objectContaining({
      type: "text",
      text: expect.stringContaining("Alpha and Beta are complete"),
    }));
    const task = runtime.get(taskId)!;
    expect(task).toMatchObject({ status: "completed", dependency: "advisory" });
    const coverage = JSON.parse(fs.readFileSync(coveragePath, "utf8"));
    expect({
      coverage,
      transcript: fs.readFileSync(task.artifacts.transcript, "utf8"),
    }).toMatchObject({
      coverage: {
        required: true,
        complete: true,
        gate_satisfied: true,
        discovered: 1,
        inspected: 1,
      },
    });
    expect(fs.readFileSync(reportPath, "utf8")).toContain("defines the exported constant");

    expect(trace.some((event) => event.type === "parent_wake")).toBe(false);
    expect(trace.some((event) => event.type === "heartbeat")).toBe(false);
    expect(trace).toContainEqual(expect.objectContaining({
      type: "background_notification_acknowledged",
      taskId,
      source: "wait",
    }));
    expect(trace).toContainEqual(expect.objectContaining({
      type: "tool_started",
      scope: "root",
      tool: "Read",
    }));
    expect(trace).toContainEqual(expect.objectContaining({
      type: "tool_started",
      scope: "subagent",
      tool: "Read",
    }));
  });

  it("runs a real three-level General recursion tree with one slot and no deadlock", async () => {
    const calls = { level1: 0, level2: 0, level3: 0 };
    const evidencePath = path.join(home, "beta", "src", "b.ts");
    provider.chat.mockImplementation(async function* (params) {
      const messageText = params.messages.flatMap((message) => {
        if (typeof message.content === "string") return [message.content];
        return message.content.flatMap((block) =>
          block.type === "text" || block.type === "tool_result"
            ? [block.type === "text" ? block.text : block.content]
            : []);
      }).join("\n");

      if (messageText.includes("Level 3 leaf")) {
        calls.level3++;
        if (calls.level3 === 1) {
          expect(params.tools.some((tool) => tool.name === "Agent")).toBe(false);
          yield { type: "tool_use_start" as const, id: "leaf-read", name: "Read" };
          yield {
            type: "tool_use_end" as const,
            id: "leaf-read",
            input: { file_path: evidencePath },
          };
        } else {
          yield { type: "tool_use_start" as const, id: "leaf-complete", name: "CompleteTask" };
          yield {
            type: "tool_use_end" as const,
            id: "leaf-complete",
            input: {
              status: "completed",
              summary: "Level 3 verified the evidence.",
              report_markdown: "# Level 3\n\nVerified `beta/src/b.ts`.",
            },
          };
        }
      } else if (messageText.includes("Level 2 coordinator")) {
        calls.level2++;
        if (calls.level2 === 1) {
          expect(params.tools.some((tool) => tool.name === "Agent")).toBe(true);
          yield { type: "tool_use_start" as const, id: "spawn-level-3", name: "Agent" };
          yield {
            type: "tool_use_end" as const,
            id: "spawn-level-3",
            input: {
              description: "Level 3 leaf",
              prompt: "Level 3 leaf: verify the evidence file.",
              subagent_type: "explore",
              dependency: "required",
            },
          };
        } else {
          expect(messageText).toContain("Level 3 verified the evidence");
          yield { type: "tool_use_start" as const, id: "level-2-complete", name: "CompleteTask" };
          yield {
            type: "tool_use_end" as const,
            id: "level-2-complete",
            input: {
              status: "completed",
              summary: "Level 2 integrated Level 3.",
              report_markdown: "# Level 2\n\nIntegrated the leaf verification.",
            },
          };
        }
      } else {
        calls.level1++;
        if (calls.level1 === 1) {
          expect(params.tools.some((tool) => tool.name === "Agent")).toBe(true);
          yield { type: "tool_use_start" as const, id: "spawn-level-2", name: "Agent" };
          yield {
            type: "tool_use_end" as const,
            id: "spawn-level-2",
            input: {
              description: "Level 2 coordinator",
              prompt: "Level 2 coordinator: delegate one independent verification leaf.",
              subagent_type: "general",
              dependency: "required",
            },
          };
        } else {
          expect(messageText).toContain("Level 2 integrated Level 3");
          yield { type: "tool_use_start" as const, id: "level-1-complete", name: "CompleteTask" };
          yield {
            type: "tool_use_end" as const,
            id: "level-1-complete",
            input: {
              status: "completed",
              summary: "Three-level recursion completed.",
              report_markdown: "# Level 1\n\nThe required child tree completed.",
            },
          };
        }
      }
      yield {
        type: "message_stop" as const,
        stopReason: "tool_use" as const,
        usage: { inputTokens: 5, outputTokens: 2 },
      };
    });

    const recursiveConfig: AgentConfig = {
      ...config,
      subagents: { ...config.subagents, maxConcurrent: 1 },
    };
    const ctx = {
      workingDir: home,
      sessionId: rootSessionId,
      readGuard: { hasRead: () => false, markAsRead: () => {}, serialize: () => ({ files: {} }) },
      permissionManager: { check: () => ({ allowed: true as const }) },
      config: recursiveConfig,
      depth: 0,
    };
    const result = await agentTool.handler({
      description: "Level 1 coordinator",
      prompt: "Level 1 coordinator: recursively coordinate two read-only levels.",
      subagent_type: "general",
      dependency: "required",
    }, ctx);

    expect(result.isError).not.toBe(true);
    expect(result.content).toContain("Three-level recursion completed");
    expect(calls).toEqual({ level1: 2, level2: 2, level3: 2 });
    const { processSubagentRegistry } = await import("../src/agent/subagents/registry.js");
    const runtime = processSubagentRegistry.get(rootSessionId)!;
    const tree = runtime.list();
    expect(tree.map((task) => task.depth)).toEqual([1, 2, 3]);
    expect(tree.every((task) => task.dependency === "required")).toBe(true);
    expect(tree.every((task) => task.status === "completed")).toBe(true);
    expect(tree.map((task) => task.subagentType)).toEqual(["general", "general", "explore"]);
  });
});
