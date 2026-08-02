import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import type {
  AgentConfig,
  AgentContext,
  SubagentDefinition,
  ToolDefinition,
} from "../src/shared/core-types.js";
import { SubagentRuntime } from "../src/agent/subagents/subagent-runtime.js";
import type {
  TaskRunnerInput,
  TaskRunnerOutput,
} from "../src/agent/subagents/task-runner.js";

const definition: SubagentDefinition = {
  name: "explore",
  description: "explore",
  systemPrompt: "read only",
  tools: [],
  readonly: true,
};
const tools: ToolDefinition[] = [];
let home = "";
let sessionCounter = 0;

function config(overrides: Partial<NonNullable<AgentConfig["subagents"]>> = {}): AgentConfig {
  return {
    model: { provider: "test", model: "test" },
    permissions: { bash: "auto", read: "auto", write: "auto", edit: "auto", web: "auto" },
    session: { cleanupPeriodDays: 30 },
    subagents: {
      maxConcurrent: 4,
      maxTasksPerSession: 32,
      maxDepth: 3,
      stallTimeoutMs: 60_000,
      hardTimeoutMs: 60_000,
      artifactTtlDays: 30,
      artifactSoftLimitBytes: 1_000_000,
      ...overrides,
    },
  };
}

function context(runtime: SubagentRuntime): AgentContext {
  return {
    workingDir: process.cwd(),
    sessionId: runtime.rootSessionId,
    readGuard: { hasRead: () => false, markAsRead: () => {}, serialize: () => ({ files: {} }) },
    permissionManager: { check: () => ({ allowed: true }) },
    config: runtime.config,
    depth: 0,
  };
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "rubato-runtime-"));
  process.env.RUBATO_HOME = home;
});

afterEach(() => {
  delete process.env.RUBATO_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

describe("SubagentRuntime lifecycle", () => {
  it("persists terminal artifacts and delivers advisory completion", async () => {
    const fakeRunner = {
      async run(input: TaskRunnerInput): Promise<TaskRunnerOutput> {
        input.onActivity("reading", "Read");
        return {
          status: "completed",
          summary: "Evidence collected.",
          report: "# Evidence\n\n`src/index.ts`",
          usage: { inputTokens: 10, outputTokens: 4, toolCalls: 1 },
        };
      },
    };
    const runtime = new SubagentRuntime(`runtime-${sessionCounter++}`, process.cwd(), config(), fakeRunner);
    const submitted = runtime.submit({
      description: "inspect",
      prompt: "inspect project",
      dependency: "advisory",
    }, context(runtime), definition, tools);
    const result = await submitted.result;
    await Promise.resolve();

    expect(result.status).toBe("completed");
    expect(fs.readFileSync(result.reportPath, "utf8")).toContain("src/index.ts");
    expect(JSON.parse(fs.readFileSync(result.resultPath, "utf8")).status).toBe("completed");
    expect(fs.readFileSync(result.transcriptPath, "utf8")).toContain("task_terminal");
    expect(runtime.inbox.drain()[0].taskIds).toEqual([result.taskId]);
  });

  it("acknowledges an advisory completion joined through wait and traces the wait", async () => {
    const fakeRunner = {
      async run(): Promise<TaskRunnerOutput> {
        return {
          status: "completed",
          summary: "joined",
          report: "# Joined",
          usage: { inputTokens: 2, outputTokens: 1, toolCalls: 0 },
        };
      },
    };
    const runtime = new SubagentRuntime(`runtime-${sessionCounter++}`, process.cwd(), config(), fakeRunner);
    const submitted = runtime.submit({
      description: "join me",
      prompt: "join me",
      dependency: "advisory",
    }, context(runtime), definition, tools);

    const result = await runtime.wait(submitted.task.taskId);
    await Promise.resolve();

    expect(result.status).toBe("completed");
    expect(runtime.inbox.drain()).toEqual([]);
    const trace = fs.readFileSync(runtime.artifacts.tracePath, "utf8")
      .trim().split("\n").map((line) => JSON.parse(line));
    expect(trace).toContainEqual(expect.objectContaining({
      type: "task_wait_started",
      taskId: result.taskId,
    }));
    expect(trace).toContainEqual(expect.objectContaining({
      type: "task_wait_completed",
      taskId: result.taskId,
      outcome: "result",
      status: "completed",
    }));
    expect(trace).toContainEqual(expect.objectContaining({
      type: "background_notification_acknowledged",
      taskId: result.taskId,
      source: "wait",
    }));
    expect(trace.some((event) => event.type === "heartbeat")).toBe(false);
  });

  it("acknowledges a queued advisory notification when its terminal detail is read", async () => {
    const fakeRunner = {
      async run(): Promise<TaskRunnerOutput> {
        return {
          status: "completed",
          summary: "inspectable",
          report: "# Inspectable",
          usage: { inputTokens: 1, outputTokens: 1, toolCalls: 0 },
        };
      },
    };
    const runtime = new SubagentRuntime(`runtime-${sessionCounter++}`, process.cwd(), config(), fakeRunner);
    const submitted = runtime.submit({
      description: "inspect me",
      prompt: "inspect me",
      dependency: "advisory",
    }, context(runtime), definition, tools);
    const result = await submitted.result;
    await Promise.resolve();

    expect(runtime.get(result.taskId)?.status).toBe("completed");
    expect(runtime.inbox.drain()).toEqual([]);
  });

  it("cancels a running task with its own AbortController", async () => {
    const fakeRunner = {
      run(input: TaskRunnerInput): Promise<TaskRunnerOutput> {
        return new Promise((_resolve, reject) => {
          input.abortSignal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      },
    };
    const runtime = new SubagentRuntime(`runtime-${sessionCounter++}`, process.cwd(), config(), fakeRunner);
    const submitted = runtime.submit({
      description: "wait",
      prompt: "wait",
      dependency: "required",
    }, context(runtime), definition, tools);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await runtime.cancel(submitted.task.taskId);
    const result = await submitted.result;

    expect(result.status).toBe("cancelled");
    expect(result.summary).toContain("cancelled");
    expect(runtime.get(result.taskId)?.endedAt).toBeTypeOf("number");
  });

  it("cancels queued work immediately without consuming a slot", async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let runs = 0;
    const fakeRunner = {
      async run(): Promise<TaskRunnerOutput> {
        runs++;
        await firstGate;
        return {
          status: "completed",
          summary: "done",
          report: "done",
          usage: { inputTokens: 0, outputTokens: 0, toolCalls: 0 },
        };
      },
    };
    const runtime = new SubagentRuntime(
      `runtime-${sessionCounter++}`,
      process.cwd(),
      config({ maxConcurrent: 1 }),
      fakeRunner,
    );
    const first = runtime.submit({ description: "first", prompt: "first" }, context(runtime), definition, tools);
    const queued = runtime.submit({ description: "queued", prompt: "queued" }, context(runtime), definition, tools);
    await runtime.cancel(queued.task.taskId);
    const cancelled = await queued.result;
    expect(cancelled.status).toBe("cancelled");
    expect(runs).toBe(1);
    releaseFirst();
    await first.result;
  });

  it("uses hard timeout only as a safety fallback", async () => {
    const fakeRunner = {
      run(): Promise<TaskRunnerOutput> {
        return new Promise(() => {});
      },
    };
    const runtime = new SubagentRuntime(
      `runtime-${sessionCounter++}`,
      process.cwd(),
      config({ hardTimeoutMs: 20, stallTimeoutMs: 10_000 }),
      fakeRunner,
    );
    const submitted = runtime.submit({
      description: "stuck",
      prompt: "never returns",
      dependency: "required",
    }, context(runtime), definition, tools);
    const result = await submitted.result;

    expect(result.status).toBe("timed_out");
    expect(fs.existsSync(result.reportPath)).toBe(true);
  });

  it("reports live task context when a wait times out without cancelling the task", async () => {
    const fakeRunner = {
      run(input: TaskRunnerInput): Promise<TaskRunnerOutput> {
        input.onActivity("model streaming", "Read");
        return new Promise((_resolve, reject) => {
          input.abortSignal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      },
    };
    const runtime = new SubagentRuntime(
      `runtime-${sessionCounter++}`,
      process.cwd(),
      config({ hardTimeoutMs: 10_000 }),
      fakeRunner,
    );
    const submitted = runtime.submit({
      description: "slow",
      prompt: "slow",
      dependency: "advisory",
    }, context(runtime), definition, tools);

    await expect(runtime.wait(submitted.task.taskId, 10)).rejects.toThrow(
      /still running.*activity=model streaming.*tool=Read.*not cancelled/i,
    );
    expect(runtime.get(submitted.task.taskId)?.status).toBe("running");

    await runtime.cancel(submitted.task.taskId);
    expect((await submitted.result).status).toBe("cancelled");
  });

  it("enforces root task and recursion-depth budgets", async () => {
    const fakeRunner = {
      async run(): Promise<TaskRunnerOutput> {
        return {
          status: "completed",
          summary: "done",
          report: "done",
          usage: { inputTokens: 0, outputTokens: 0, toolCalls: 0 },
        };
      },
    };
    const runtime = new SubagentRuntime(
      `runtime-${sessionCounter++}`,
      process.cwd(),
      config({ maxTasksPerSession: 1, maxDepth: 1 }),
      fakeRunner,
    );
    const parent = context(runtime);
    const first = runtime.submit({ description: "one", prompt: "one" }, parent, definition, tools);
    await first.result;
    const second = runtime.submit({ description: "two", prompt: "two" }, parent, definition, tools);
    expect((await second.result).status).toBe("failed");
    expect((await second.result).summary).toContain("budget");
  });

  it("runs a three-level required recursion tree with one slot and no deadlock", async () => {
    let runtime!: SubagentRuntime;
    const recursiveGeneral: SubagentDefinition = {
      name: "general",
      description: "recursive coordinator",
      systemPrompt: "coordinate",
      tools: [],
      readonly: true,
      canSpawn: true,
    };
    const verify: SubagentDefinition = {
      name: "verify",
      description: "leaf verifier",
      systemPrompt: "verify",
      tools: [],
      readonly: true,
    };
    const fakeRunner = {
      async run(input: TaskRunnerInput): Promise<TaskRunnerOutput> {
        if (input.depth < 3) {
          const parentCtx: AgentContext = {
            ...context(runtime),
            depth: input.depth,
            taskRuntime: {
              rootSessionId: input.rootSessionId,
              taskId: input.taskId,
              agentId: input.agentId,
              parentTaskId: input.parentTaskId,
              depth: input.depth,
              completionSubmitted: false,
            },
          };
          const childDefinition = input.depth === 1 ? recursiveGeneral : verify;
          const child = runtime.submit({
            description: `depth-${input.depth + 1}`,
            prompt: "collect independent evidence",
            dependency: "advisory",
          }, parentCtx, childDefinition, tools);
          const childResult = await child.result;
          expect(childResult.status).toBe("completed");
        }
        return {
          status: "completed",
          summary: `depth ${input.depth} complete`,
          report: `# Depth ${input.depth}`,
          usage: { inputTokens: 1, outputTokens: 1, toolCalls: input.depth < 3 ? 1 : 0 },
        };
      },
    };
    runtime = new SubagentRuntime(
      `runtime-${sessionCounter++}`,
      process.cwd(),
      config({ maxConcurrent: 1, maxDepth: 3 }),
      fakeRunner,
    );
    const rootTask = runtime.submit({
      description: "root general",
      prompt: "coordinate exploration and verification",
      dependency: "required",
    }, context(runtime), recursiveGeneral, tools);
    const result = await rootTask.result;

    expect(result.status).toBe("completed");
    const tree = runtime.list();
    expect(tree.map((task) => task.depth)).toEqual([1, 2, 3]);
    expect(tree.every((task) => task.dependency === "required")).toBe(true);
    expect(tree.every((task) => task.status === "completed")).toBe(true);
  });
});
