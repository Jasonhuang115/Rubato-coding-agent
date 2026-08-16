import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "../src/agent/subagents/artifact-store.js";
import { TaskScheduler } from "../src/agent/subagents/task-scheduler.js";
import { TraceSink } from "../src/agent/subagents/trace-sink.js";
import type { TaskDetail, TaskResult } from "../src/shared/core-types.js";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("scheduler, trace, and artifact invariants", () => {
  it("runs jobs FIFO under a fixed concurrency ceiling", async () => {
    const scheduler = new TaskScheduler(1);
    const order: string[] = [];
    let release!: () => void;
    scheduler.enqueue({
      taskId: "first",
      run: async () => {
        order.push("first-start");
        await new Promise<void>((resolve) => { release = resolve; });
        order.push("first-end");
      },
    });
    scheduler.enqueue({ taskId: "second", run: async () => { order.push("second"); } });
    expect(scheduler.activeCount).toBe(1);
    expect(scheduler.queuedCount).toBe(1);
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual(["first-start", "first-end", "second"]);
  });

  it("redacts secrets, excludes reasoning, and blobs large output", () => {
    const rubatoHome = fs.mkdtempSync(path.join(os.tmpdir(), "rubato-trace-"));
    tempDirs.push(rubatoHome);
    const artifacts = new ArtifactStore(process.cwd(), "trace-session", rubatoHome);
    const trace = new TraceSink(artifacts);
    const taskId = "task-1";
    fs.mkdirSync(artifacts.paths(taskId).taskDir, { recursive: true });
    trace.append({
      type: "tool_completed",
      sessionId: "trace-session",
      taskId,
      Authorization: "Bearer abcdefghijklmnopqrstuvwxyz",
      output: "x".repeat(31_000),
      reasoning: "private chain",
    });
    trace.append({ type: "thinking", sessionId: "trace-session", taskId, text: "private" });
    const lines = fs.readFileSync(artifacts.tracePath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const event = JSON.parse(lines[0]);
    expect(event.Authorization).toBe("[REDACTED]");
    expect(event).not.toHaveProperty("reasoning");
    expect(event.output.blob.length).toBe(31_000);
    expect(fs.existsSync(event.output.blob.path)).toBe(true);
  });

  it("protects pinned artifacts and recovers interrupted tasks as failed", () => {
    const rubatoHome = fs.mkdtempSync(path.join(os.tmpdir(), "rubato-artifacts-"));
    tempDirs.push(rubatoHome);
    const artifacts = new ArtifactStore(process.cwd(), "artifact-session", rubatoHome);
    const makeTask = (taskId: string): TaskDetail => {
      const now = Date.now() - 10_000;
      return {
        taskId,
        agentId: `agent-${taskId}`,
        rootSessionId: "artifact-session",
        description: taskId,
        prompt: taskId,
        subagentType: "explore",
        status: "finished",
        createdAt: now,
        endedAt: now,
        lastActivityAt: now,
        artifacts: artifacts.paths(taskId),
      };
    };
    const finalize = (task: TaskDetail) => {
      const result: TaskResult = {
        taskId: task.taskId,
        agentId: task.agentId,
        status: "finished",
        reportPath: task.artifacts.report,
        resultPath: task.artifacts.result,
        transcriptPath: task.artifacts.transcript,
        coveragePath: task.artifacts.coverage,
        usage: { inputTokens: 0, outputTokens: 0, toolCalls: 0 },
        endedAt: task.endedAt!,
      };
      artifacts.initializeTask(task);
      artifacts.finalizeTask(task, result);
    };

    const pinned = makeTask("task-pinned");
    const removable = makeTask("task-removable");
    finalize(pinned);
    finalize(removable);
    artifacts.setPinned(pinned.taskId, true);
    const prune = artifacts.prune({ ttlMs: 0, softLimitBytes: 0 });
    expect(prune.removed).toContain(removable.taskId);
    expect(prune.removed).not.toContain(pinned.taskId);

  });
});
