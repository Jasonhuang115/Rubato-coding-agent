import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReadGuard } from "../src/agent/read-guard.js";
import { formatSubagentStatus } from "../src/agent/loop.js";
import { GENERAL_DEF } from "../src/agent/subagent.js";
import { RootDelegationGate } from "../src/agent/delegation-gate.js";
import { ArtifactStore } from "../src/agent/subagents/artifact-store.js";
import { emptyCoverageManifest } from "../src/agent/subagents/coverage.js";
import { SubagentRuntime } from "../src/agent/subagents/subagent-runtime.js";
import { processStream } from "../src/runtime/step-executor.js";
import { FsSandbox } from "../src/security/sandbox/fs-sandbox.js";
import type {
  AgentConfig,
  AgentContext,
  ModelProvider,
  StreamRenderer,
} from "../src/shared/core-types.js";
import { subagentTool } from "../src/tools/subagent.js";
import { taskTool } from "../src/tools/task.js";
import { PLAN_TOOL_NAMES } from "../src/tools/registry.js";

const finishedOutput = {
  status: "finished" as const,
  coverage: emptyCoverageManifest(false),
  usage: { inputTokens: 1, outputTokens: 2, toolCalls: 0 },
};

describe("fully asynchronous Subagent runtime", () => {
  let root: string;
  let rubatoHome: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "rubato-async-root-"));
    rubatoHome = fs.mkdtempSync(path.join(os.tmpdir(), "rubato-async-home-"));
    process.env.RUBATO_HOME = rubatoHome;
  });

  afterEach(() => {
    delete process.env.RUBATO_HOME;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(rubatoHome, { recursive: true, force: true });
  });

  it("exposes the Subagent contract and removes wait/watch from Task", () => {
    expect(subagentTool.name).toBe("Subagent");
    expect(subagentTool.inputSchema.required).toContain("timeout_ms");
    expect(subagentTool.description).toContain("not a work budget");
    const actions = (taskTool.inputSchema.properties.action as { enum: string[] }).enum;
    expect(actions).not.toContain("wait");
    expect(actions).not.toContain("watch");
  });

  it("uses Subagent as the plan-mode delegation gate", () => {
    const gate = new RootDelegationGate("并行检查所有模块");
    gate.prepareTurn([{ name: "Subagent", input: {} }]);
    expect(gate.check("Read", {})).toBeNull();
    expect(gate.check("Subagent", {})).toBeNull();
    gate.recordToolResult("Subagent", true);
    expect(gate.check("Bash", {})).toBeNull();
    expect(PLAN_TOOL_NAMES.has("Subagent")).toBe(true);
  });

  it("creates unique report files before returning and queues FIFO", async () => {
    const releases: Array<() => void> = [];
    const starts: string[] = [];
    const runner = {
      run: vi.fn(async (input: Parameters<SubagentRuntime["submit"]>[0] extends never
        ? never
        : any) => {
        starts.push(input.taskId);
        input.appendReport(`started ${input.taskId}`);
        await new Promise<void>((resolve) => releases.push(resolve));
        return finishedOutput;
      }),
    };
    const runtime = new SubagentRuntime("session", root, config({ maxConcurrent: 1 }), runner);
    const first = runtime.submit(taskInput("first"), context(root), GENERAL_DEF, []);
    const second = runtime.submit(taskInput("second"), context(root), GENERAL_DEF, []);

    expect(first.task.taskId).not.toBe(second.task.taskId);
    expect(first.task.artifacts.report).not.toBe(second.task.artifacts.report);
    expect(fs.existsSync(first.task.artifacts.report)).toBe(true);
    expect(fs.existsSync(second.task.artifacts.report)).toBe(true);
    expect(runtime.get(first.task.taskId)?.status).toBe("running");
    expect(runtime.get(second.task.taskId)?.status).toBe("queued");
    expect(fs.readFileSync(first.task.artifacts.report, "utf8")).toContain("started");

    releases.shift()?.();
    await terminal(runtime, first.task.taskId);
    await vi.waitFor(() => expect(starts).toHaveLength(2));
    releases.shift()?.();
    await terminal(runtime, second.task.taskId);
    expect(starts).toEqual([first.task.taskId, second.task.taskId]);
  });

  it("delivers each terminal transition once without report content", async () => {
    const runtime = new SubagentRuntime("session", root, config(), {
      run: async (input: any) => {
        input.appendReport("secret report body");
        return finishedOutput;
      },
    });
    const submitted = runtime.submit(taskInput("terminal"), context(root), GENERAL_DEF, []);
    const result = await terminal(runtime, submitted.task.taskId);
    await Promise.resolve();

    const [event] = runtime.inbox.drain();
    expect(event.results).toEqual([{
      taskId: result.taskId,
      status: "finished",
      reportPath: result.reportPath,
      error: undefined,
    }]);
    expect(JSON.stringify(event)).not.toContain("secret report body");
    expect(runtime.get(result.taskId)?.status).toBe("finished");
    expect(runtime.inbox.drain()).toEqual([]);
  });

  it("emits queued, running, and terminal states in order", async () => {
    let release!: () => void;
    const runtime = new SubagentRuntime("session", root, config(), {
      run: async () => {
        await new Promise<void>((resolve) => { release = resolve; });
        return finishedOutput;
      },
    });
    const states: string[] = [];
    runtime.subscribe((task) => states.push(task.status));
    const submitted = runtime.submit(taskInput("states"), context(root), GENERAL_DEF, []);
    release();
    await terminal(runtime, submitted.task.taskId);
    expect(states).toEqual(["queued", "running", "finished"]);
  });

  it("represents cancellation as failed with a failure kind", async () => {
    const runtime = new SubagentRuntime("session", root, config(), {
      run: async (input: any) => {
        await new Promise((_resolve, reject) => {
          input.abortSignal.addEventListener("abort", () => reject(input.abortSignal.reason));
        });
        return finishedOutput;
      },
    });
    const submitted = runtime.submit(taskInput("cancel"), context(root), GENERAL_DEF, []);
    await runtime.cancel(submitted.task.taskId);
    await expect(terminal(runtime, submitted.task.taskId)).resolves.toMatchObject({
      status: "failed",
      failureKind: "cancelled",
    });
  });

  it("keeps task-count rejection in the new failed state model", async () => {
    const runtime = new SubagentRuntime("session", root, config({ maxTasksPerSession: 1 }), {
      run: async () => finishedOutput,
    });
    const accepted = runtime.submit(taskInput("accepted"), context(root), GENERAL_DEF, []);
    await terminal(runtime, accepted.task.taskId);
    const rejected = runtime.submit(taskInput("rejected"), context(root), GENERAL_DEF, []);
    await expect(terminal(runtime, rejected.task.taskId)).resolves.toMatchObject({ status: "failed" });
    expect(fs.existsSync(rejected.task.artifacts.report)).toBe(true);
  });

  it("preserves partial report content when the safety timeout fails a task", async () => {
    const runner = {
      run: async (input: any) => {
        input.appendReport("durable partial evidence");
        await new Promise((_resolve, reject) => {
          input.abortSignal.addEventListener("abort", () => reject(input.abortSignal.reason));
        });
        return finishedOutput;
      },
    };
    const runtime = new SubagentRuntime("session", root, config(), runner);
    const submitted = runtime.submit(
      { ...taskInput("timeout"), timeout_ms: 15 },
      context(root),
      GENERAL_DEF,
      [],
    );
    const result = await terminal(runtime, submitted.task.taskId);

    expect(result).toMatchObject({ status: "failed", failureKind: "timed_out" });
    expect(fs.readFileSync(result.reportPath, "utf8")).toContain("durable partial evidence");
  });

  it("injects a complete ephemeral status snapshot with report paths", async () => {
    let release!: () => void;
    const runtime = new SubagentRuntime("session", root, config(), {
      run: async () => {
        await new Promise<void>((resolve) => { release = resolve; });
        return finishedOutput;
      },
    });
    const submitted = runtime.submit(taskInput("snapshot task"), context(root), GENERAL_DEF, []);
    const snapshot = formatSubagentStatus(runtime);
    expect(snapshot).toContain(submitted.task.taskId);
    expect(snapshot).toContain("snapshot task");
    expect(snapshot).toContain("status: running");
    expect(snapshot).toContain(submitted.task.artifacts.report);
    expect(snapshot).not.toContain(submitted.task.prompt);
    release();
    await terminal(runtime, submitted.task.taskId);
  });

  it("rejects nested dispatch and invalid timeout at the tool boundary", async () => {
    const nested = await subagentTool.handler(
      { description: "nested", prompt: "x", timeout_ms: 1_000 },
      { ...context(root), taskRuntime: {
        rootSessionId: "session",
        taskId: "parent",
        agentId: "worker",
      } },
    );
    expect(nested.isError).toBe(true);

    const invalid = await subagentTool.handler(
      { description: "bad", prompt: "x", timeout_ms: 0 },
      context(root),
    );
    expect(invalid.isError).toBe(true);
  });

  it("never overwrites an append-only report during finalization", () => {
    const store = new ArtifactStore(root, "session", rubatoHome);
    const now = Date.now();
    const task = {
      taskId: "task-one",
      agentId: "agent-one",
      rootSessionId: "session",
      description: "append",
      prompt: "prompt",
      subagentType: "general",
      status: "running" as const,
      createdAt: now,
      lastActivityAt: now,
      artifacts: store.paths("task-one"),
    };
    store.initializeTask(task);
    store.appendReport(task.taskId, "progress survives");
    store.finalizeTask(task, {
      taskId: task.taskId,
      agentId: task.agentId,
      status: "finished",
      reportPath: task.artifacts.report,
      resultPath: task.artifacts.result,
      transcriptPath: task.artifacts.transcript,
      coveragePath: task.artifacts.coverage,
      usage: { inputTokens: 0, outputTokens: 0, toolCalls: 0 },
      endedAt: now,
    });
    expect(fs.readFileSync(task.artifacts.report, "utf8")).toContain("progress survives");
    expect(fs.readFileSync(task.artifacts.report, "utf8")).toContain("## Plan");
    expect(fs.readFileSync(task.artifacts.report, "utf8")).toContain("## Report");
  });

  it("streams only visible text deltas to the report callback", async () => {
    const visible: string[] = [];
    const provider: ModelProvider = {
      name: "test",
      async *chat() {
        yield { type: "thinking_delta" as const, text: "private thought" };
        yield { type: "text_delta" as const, text: "public evidence" };
        yield {
          type: "message_stop" as const,
          stopReason: "end_turn",
          usage: { inputTokens: 1, outputTokens: 2 },
        };
      },
      async countTokens() { return 1; },
    };
    await processStream(
      provider,
      {
        model: "test",
        system: "",
        messages: [],
        tools: [],
        maxTokens: 10,
        signal: new AbortController().signal,
      },
      renderer(),
      undefined,
      (delta) => visible.push(delta),
    );
    expect(visible.join("")).toBe("public evidence");
  });

  it("allows native reads only for the current project's task artifacts", () => {
    const store = new ArtifactStore(root, "session", rubatoHome);
    const paths = store.paths("task-one");
    fs.mkdirSync(paths.taskDir, { recursive: true });
    fs.writeFileSync(paths.report, "report", "utf8");
    const sandbox = new FsSandbox();
    expect(sandbox.validate("Read", { file_path: paths.report }, root).allowed).toBe(true);

    const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rubato-other-root-"));
    const other = new ArtifactStore(otherRoot, "session", rubatoHome).paths("task-two");
    fs.mkdirSync(other.taskDir, { recursive: true });
    fs.writeFileSync(other.report, "other", "utf8");
    expect(sandbox.validate("Read", { file_path: other.report }, root).allowed).toBe(false);
    fs.rmSync(otherRoot, { recursive: true, force: true });
  });
});

function taskInput(description: string) {
  return { description, prompt: `do ${description}`, timeout_ms: 60_000 };
}

async function terminal(runtime: SubagentRuntime, taskId: string) {
  await vi.waitFor(() => expect(runtime.get(taskId)?.result).toBeDefined());
  return runtime.get(taskId)!.result!;
}

function config(subagents: AgentConfig["subagents"] = {}): AgentConfig {
  return {
    model: { provider: "test", model: "test" },
    permissions: { bash: "auto", read: "auto", write: "auto", edit: "auto", web: "auto" },
    session: { cleanupPeriodDays: 30 },
    subagents,
    worktree: { baseRef: "head" },
  };
}

function context(workingDir: string): AgentContext {
  return {
    workingDir,
    sessionId: "session",
    readGuard: new ReadGuard(),
    permissionManager: { check: () => ({ allowed: true }) },
    config: config(),
    mode: "default",
    depth: 0,
  };
}

function renderer(): StreamRenderer {
  return {
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
}
