import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { SubagentRuntime } from "../src/agent/subagents/subagent-runtime.js";
import { ArtifactStore } from "../src/agent/subagents/artifact-store.js";
import { WorktreeManager } from "../src/agent/worktrees/worktree-manager.js";
import type {
  AgentConfig,
  AgentContext,
  SubagentDefinition,
  TaskDetail,
} from "../src/shared/core-types.js";
import type {
  TaskRunnerInput,
  TaskRunnerOutput,
} from "../src/agent/subagents/task-runner.js";

const roots: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function repository(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rubato-runtime-worktree-"));
  roots.push(root);
  git(root, "init", "-q");
  git(root, "config", "user.name", "Rubato Test");
  git(root, "config", "user.email", "rubato@example.test");
  fs.writeFileSync(path.join(root, "base.txt"), "base\n");
  git(root, "add", "base.txt");
  git(root, "commit", "-qm", "base");
  return root;
}

function config(): AgentConfig {
  return {
    model: { provider: "test", model: "test" },
    permissions: {
      bash: "auto",
      read: "auto",
      write: "auto",
      edit: "auto",
      web: "auto",
    },
    session: { cleanupPeriodDays: 30 },
    worktree: { baseRef: "head" },
    subagents: {
      maxConcurrent: 2,
      maxWriteConcurrent: 1,
      maxTasksPerSession: 8,
      maxDepth: 3,
      stallTimeoutMs: 60_000,
      hardTimeoutMs: 60_000,
      artifactTtlDays: 30,
      artifactSoftLimitBytes: 10_000_000,
    },
  };
}

const worker: SubagentDefinition = {
  name: "worker",
  description: "worker",
  systemPrompt: "implement and commit",
  tools: ["Read", "Write", "Edit", "Bash"],
  readonly: false,
  isolation: "worktree",
  canSpawn: false,
};

afterEach(() => {
  delete process.env.RUBATO_HOME;
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("SubagentRuntime worktree writer", () => {
  it("runs in isolation and returns integration evidence without touching root", async () => {
    const root = repository();
    const artifactHome = fs.mkdtempSync(path.join(os.tmpdir(), "rubato-artifacts-"));
    roots.push(artifactHome);
    process.env.RUBATO_HOME = artifactHome;
    const runner = {
      async run(input: TaskRunnerInput): Promise<TaskRunnerOutput> {
        expect(input.workingDir).not.toBe(root);
        fs.writeFileSync(path.join(input.workingDir, "feature.txt"), "worker output\n");
        git(input.workingDir, "add", "feature.txt");
        git(input.workingDir, "commit", "-qm", "worker implementation");
        return {
          status: "completed",
          summary: "Implemented and committed.",
          report: "# Worker result\n\nImplementation committed.",
          usage: { inputTokens: 2, outputTokens: 2, toolCalls: 3 },
        };
      },
    };
    const runtime = new SubagentRuntime("root-session", root, config(), runner);
    const context = {
      workingDir: root,
      sessionId: "root-session",
      config: runtime.config,
      depth: 0,
    } as AgentContext;

    const submitted = runtime.submit({
      description: "implement feature",
      prompt: "Create feature.txt and commit it.",
      dependency: "required",
      isolation: "worktree",
      scope: ["feature.txt"],
    }, context, worker, []);
    const result = await submitted.result;

    expect(fs.existsSync(path.join(root, "feature.txt"))).toBe(false);
    expect(result.status).toBe("completed");
    expect(result.workspace).toMatchObject({
      dirty: false,
      filesChanged: ["feature.txt"],
      scopeDeviations: [],
    });
    expect(result.workspace?.commits).toHaveLength(1);
    expect(fs.readFileSync(result.workspace!.patchPath, "utf8")).toContain("worker output");

    git(root, "merge", "--no-ff", "-m", "integrate worker", result.workspace!.branch);
    expect(fs.readFileSync(path.join(root, "feature.txt"), "utf8")).toBe("worker output\n");
    await runtime.cleanup(result.taskId);
    expect(fs.existsSync(result.workspace!.path)).toBe(false);
  });

  it("serializes concurrent worker permission prompts through the root callback", async () => {
    const root = repository();
    const artifactHome = fs.mkdtempSync(path.join(os.tmpdir(), "rubato-artifacts-"));
    roots.push(artifactHome);
    process.env.RUBATO_HOME = artifactHome;
    let activePrompts = 0;
    let maximumPrompts = 0;
    const order: string[] = [];
    const runner = {
      async run(input: TaskRunnerInput): Promise<TaskRunnerOutput> {
        await input.onConfirmTool?.("Bash", { command: input.taskId });
        return {
          status: "completed",
          summary: "Permission relayed.",
          report: "# Permission relayed",
          usage: { inputTokens: 1, outputTokens: 1, toolCalls: 1 },
        };
      },
    };
    const runtime = new SubagentRuntime("permission-root", root, config(), runner);
    const context = {
      workingDir: root,
      sessionId: "permission-root",
      config: runtime.config,
      depth: 0,
      onConfirmTool: async (_toolName: string, input: Record<string, unknown>) => {
        const id = String(input.command);
        activePrompts++;
        maximumPrompts = Math.max(maximumPrompts, activePrompts);
        order.push(`start:${id}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
        order.push(`end:${id}`);
        activePrompts--;
        return "allow_once" as const;
      },
    } as AgentContext;
    const reader: SubagentDefinition = {
      name: "reader",
      description: "reader",
      systemPrompt: "read",
      tools: [],
      readonly: true,
    };

    const first = runtime.submit({
      description: "first",
      prompt: "first",
      dependency: "advisory",
    }, context, reader, []);
    const second = runtime.submit({
      description: "second",
      prompt: "second",
      dependency: "advisory",
    }, context, reader, []);
    await Promise.all([first.result, second.result]);

    expect(maximumPrompts).toBe(1);
    expect(order).toHaveLength(4);
    expect(order[0]).toMatch(/^start:/);
    expect(order[1]).toBe(`end:${order[0].slice("start:".length)}`);
    expect(order[2]).toMatch(/^start:/);
    expect(order[3]).toBe(`end:${order[2].slice("start:".length)}`);
  });

  it("rejects missing or overlapping active writer scopes", async () => {
    const root = repository();
    const artifactHome = fs.mkdtempSync(path.join(os.tmpdir(), "rubato-artifacts-"));
    roots.push(artifactHome);
    process.env.RUBATO_HOME = artifactHome;
    let releaseRunner!: () => void;
    const blocked = new Promise<void>((resolve) => { releaseRunner = resolve; });
    const runner = {
      async run(): Promise<TaskRunnerOutput> {
        await blocked;
        return {
          status: "completed",
          summary: "No changes.",
          report: "# No changes",
          usage: { inputTokens: 1, outputTokens: 1, toolCalls: 0 },
        };
      },
    };
    const runtime = new SubagentRuntime("scope-root", root, config(), runner);
    const context = {
      workingDir: root,
      sessionId: "scope-root",
      config: runtime.config,
      depth: 0,
    } as AgentContext;

    const missing = runtime.submit({
      description: "missing scope",
      prompt: "write",
      dependency: "required",
      isolation: "worktree",
    }, context, worker, []);
    expect((await missing.result).summary).toContain("require an explicit");

    const first = runtime.submit({
      description: "first writer",
      prompt: "write src",
      dependency: "advisory",
      isolation: "worktree",
      scope: ["src/"],
    }, context, worker, []);
    const overlap = runtime.submit({
      description: "overlap",
      prompt: "write api",
      dependency: "required",
      isolation: "worktree",
      scope: ["src/api/"],
    }, context, worker, []);
    expect((await overlap.result).summary).toContain("overlaps active task");

    releaseRunner();
    await first.result;
  });

  it("recovers the actual branch, commits, diff, and dirty state after interruption", () => {
    const root = repository();
    const artifactHome = fs.mkdtempSync(path.join(os.tmpdir(), "rubato-artifacts-"));
    roots.push(artifactHome);
    process.env.RUBATO_HOME = artifactHome;
    const manager = new WorktreeManager(root, config());
    const workspace = manager.create("orphan-task", "orphan-root");
    fs.writeFileSync(path.join(workspace.path, "recovered.txt"), "recover me\n");
    git(workspace.path, "add", "recovered.txt");
    git(workspace.path, "commit", "-qm", "recoverable commit");
    const store = new ArtifactStore(root, "orphan-root");
    const detail: TaskDetail = {
      taskId: "orphan-task",
      agentId: "orphan-agent",
      rootSessionId: "orphan-root",
      description: "recover",
      prompt: "recover",
      subagentType: "worker",
      dependency: "required",
      status: "running",
      depth: 1,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      childCount: 0,
      scope: ["recovered.txt"],
      workspace,
      artifacts: store.paths("orphan-task"),
    };
    store.initializeTask(detail);

    const [result] = store.recoverOrphaned();

    expect(result.status).toBe("orphaned");
    expect(result.workspace).toMatchObject({
      branch: workspace.branch,
      dirty: false,
      filesChanged: ["recovered.txt"],
      scopeDeviations: [],
    });
    expect(result.workspace?.commits).toHaveLength(1);
    expect(fs.readFileSync(result.workspace!.patchPath, "utf8")).toContain("recover me");
  });
});
