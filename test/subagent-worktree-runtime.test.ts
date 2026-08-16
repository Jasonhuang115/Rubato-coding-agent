import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyCoverageManifest } from "../src/agent/subagents/coverage.js";
import { SubagentRuntime } from "../src/agent/subagents/subagent-runtime.js";
import type { TaskRunnerInput, TaskRunnerOutput } from "../src/agent/subagents/task-runner.js";
import type { AgentConfig, AgentContext, SubagentDefinition } from "../src/shared/core-types.js";

const roots: string[] = [];
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
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
    permissions: { bash: "auto", read: "auto", write: "auto", edit: "auto", web: "auto" },
    session: { cleanupPeriodDays: 30 },
    worktree: { baseRef: "head" },
    subagents: {
      maxConcurrent: 2,
      maxWriteConcurrent: 1,
      maxTasksPerSession: 8,
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
};
afterEach(() => {
  delete process.env.RUBATO_HOME;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("SubagentRuntime worktree writer", () => {
  it("returns integration evidence without touching the root checkout", async () => {
    const root = repository();
    const artifactHome = fs.mkdtempSync(path.join(os.tmpdir(), "rubato-artifacts-"));
    roots.push(artifactHome);
    process.env.RUBATO_HOME = artifactHome;
    const runner = {
      async run(input: TaskRunnerInput): Promise<TaskRunnerOutput> {
        expect(input.workingDir).not.toBe(root);
        input.appendReport("implementation started");
        fs.writeFileSync(path.join(input.workingDir, "feature.txt"), "worker output\n");
        git(input.workingDir, "add", "feature.txt");
        git(input.workingDir, "commit", "-qm", "worker implementation");
        return {
          status: "finished",
          coverage: emptyCoverageManifest(false),
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
      timeout_ms: 60_000,
      isolation: "worktree",
      scope: ["feature.txt"],
    }, context, worker, []);
    await vi.waitFor(() => expect(runtime.get(submitted.task.taskId)?.result).toBeDefined());
    const result = runtime.get(submitted.task.taskId)!.result!;
    expect(fs.existsSync(path.join(root, "feature.txt"))).toBe(false);
    expect(result.status).toBe("finished");
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

  it("rejects missing and overlapping writer scopes before execution", async () => {
    const root = repository();
    const artifactHome = fs.mkdtempSync(path.join(os.tmpdir(), "rubato-artifacts-"));
    roots.push(artifactHome);
    process.env.RUBATO_HOME = artifactHome;
    let release!: () => void;
    const runtime = new SubagentRuntime("root-session", root, config(), {
      run: async () => {
        await new Promise<void>((resolve) => { release = resolve; });
        return {
          status: "finished",
          coverage: emptyCoverageManifest(false),
          usage: { inputTokens: 0, outputTokens: 0, toolCalls: 0 },
        };
      },
    });
    const ctx = { workingDir: root, sessionId: "root-session", config: runtime.config, depth: 0 } as AgentContext;
    const missing = runtime.submit({
      description: "missing", prompt: "missing", timeout_ms: 60_000, isolation: "worktree",
    }, ctx, worker, []);
    expect(runtime.get(missing.task.taskId)).toMatchObject({ status: "failed" });
    const first = runtime.submit({
      description: "first", prompt: "first", timeout_ms: 60_000,
      isolation: "worktree", scope: ["src"],
    }, ctx, worker, []);
    const overlap = runtime.submit({
      description: "overlap", prompt: "overlap", timeout_ms: 60_000,
      isolation: "worktree", scope: ["src/nested"],
    }, ctx, worker, []);
    expect(runtime.get(overlap.task.taskId)).toMatchObject({ status: "failed" });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    release();
    await vi.waitFor(() => expect(runtime.get(first.task.taskId)?.result).toBeDefined());
  });
});
