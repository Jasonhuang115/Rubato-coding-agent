import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReadGuard } from "../src/agent/read-guard.js";
import { GENERAL_DEF } from "../src/agent/subagent.js";
import { SubagentRuntime } from "../src/agent/subagents/subagent-runtime.js";
import { emptyCoverageManifest } from "../src/agent/subagents/coverage.js";
import type { AgentConfig, AgentContext } from "../src/shared/core-types.js";

describe("persistent Subagent recovery", () => {
  let root: string;
  let home: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "rubato-persist-root-"));
    home = fs.mkdtempSync(path.join(os.tmpdir(), "rubato-persist-home-"));
    process.env.RUBATO_HOME = home;
  });

  afterEach(() => {
    delete process.env.RUBATO_HOME;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("pauses a running task and resumes it from the same report in a new run", async () => {
    const first = new SubagentRuntime("conversation-1", root, config(), {
      run: async (input) => {
        input.appendReport("first attempt evidence");
        await new Promise<void>((_resolve, reject) => {
          input.abortSignal.addEventListener("abort", () => reject(new Error("paused")), { once: true });
        });
        throw new Error("unreachable");
      },
    }, "root-run-1");
    const submitted = first.submit({
      description: "persistent task",
      prompt: "continue after restart",
      timeout_ms: 60_000,
    }, context(root), GENERAL_DEF, []);
    await vi.waitFor(() => expect(first.get(submitted.task.taskId)?.status).toBe("running"));
    first.pauseAll();
    await vi.waitFor(() => expect(first.get(submitted.task.taskId)?.status).toBe("queued"));
    const before = first.get(submitted.task.taskId)!;
    const beforeSpec = JSON.parse(fs.readFileSync(before.artifacts.task, "utf8")) as {
      accumulatedRuntimeMs?: number;
      attempt?: number;
    };
    expect(beforeSpec.accumulatedRuntimeMs).toBeGreaterThanOrEqual(0);
    expect(fs.readFileSync(before.artifacts.report, "utf8")).toContain("first attempt evidence");

    const second = new SubagentRuntime("conversation-1", root, config(), {
      run: async (input) => {
        expect(input.prompt).toContain("Recovery instructions");
        expect(input.prompt).toContain(before.artifacts.report);
        input.appendReport("second attempt completed");
        return {
          status: "finished",
          coverage: emptyCoverageManifest(false),
          usage: { inputTokens: 1, outputTokens: 1, toolCalls: 0 },
        };
      },
    }, "root-run-2");
    await second.resumePersistedTasks();
    await vi.waitFor(() => expect(second.get(submitted.task.taskId)?.status).toBe("finished"));
    const after = second.get(submitted.task.taskId)!;
    const afterSpec = JSON.parse(fs.readFileSync(after.artifacts.task, "utf8")) as {
      attempt?: number;
    };
    expect(afterSpec.attempt).toBe(2);
    expect(fs.readFileSync(after.artifacts.report, "utf8")).toContain("second attempt completed");
  });
});

function config(): AgentConfig {
  return {
    model: { provider: "test", model: "test" },
    permissions: { bash: "auto", read: "auto", write: "auto", edit: "auto", web: "auto" },
    session: { cleanupPeriodDays: 30 },
    subagents: {
      maxConcurrent: 1,
      maxWriteConcurrent: 1,
      maxTasksPerSession: 8,
      artifactTtlDays: 30,
      artifactSoftLimitBytes: 10_000_000,
    },
  };
}

function context(workingDir: string): AgentContext {
  return {
    workingDir,
    sessionId: "root-run-1",
    conversationId: "conversation-1",
    runId: "root-run-1",
    readGuard: new ReadGuard(),
    permissionManager: { check: () => ({ allowed: true }) },
    config: config(),
    mode: "default",
    depth: 0,
  };
}
