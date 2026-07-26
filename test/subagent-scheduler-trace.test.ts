import { afterEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { TaskScheduler } from "../src/agent/subagents/task-scheduler.js";
import { ArtifactStore } from "../src/agent/subagents/artifact-store.js";
import { TraceSink } from "../src/agent/subagents/trace-sink.js";
import type { TaskDetail, TaskResult } from "../src/shared/core-types.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("scheduler and trace invariants", () => {
  it("releases a parent slot while a required child runs, then reacquires it", async () => {
    const scheduler = new TaskScheduler(1);
    const order: string[] = [];
    let releaseParent!: () => void;
    const parentGate = new Promise<void>((resolve) => { releaseParent = resolve; });
    const parentDone = new Promise<void>((resolve) => {
      scheduler.enqueue({
        taskId: "parent",
        dependency: "required",
        depth: 1,
        createdAt: 1,
        run: async () => {
          order.push("parent-start");
          await parentGate;
          order.push("parent-end");
          resolve();
        },
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(scheduler.activeCount).toBe(1);
    expect(scheduler.suspendForChild("parent")).toBe(true);
    const childDone = new Promise<void>((resolve) => {
      scheduler.enqueue({
        taskId: "child",
        dependency: "required",
        depth: 2,
        createdAt: 2,
        run: async () => {
          order.push("child");
          resolve();
        },
      });
    });
    await childDone;
    const reacquired = scheduler.reacquireAfterChild("parent");
    await reacquired;
    releaseParent();
    await parentDone;

    expect(order).toEqual(["parent-start", "child", "parent-end"]);
  });

  it("redacts secrets, excludes reasoning, and stores large output as a blob", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rubato-trace-"));
    tempDirs.push(root);
    const artifacts = new ArtifactStore(process.cwd(), "trace-session", root);
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
    trace.append({
      type: "thinking",
      sessionId: "trace-session",
      taskId,
      text: "must not persist",
    });
    const resumedTrace = new TraceSink(artifacts);
    resumedTrace.append({
      type: "task_terminal",
      sessionId: "trace-session",
      taskId,
      usage: { inputTokens: 12, outputTokens: 3 },
    });

    const lines = fs.readFileSync(artifacts.tracePath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    const event = JSON.parse(lines[0]);
    expect(event.Authorization).toBe("[REDACTED]");
    expect(event).not.toHaveProperty("reasoning");
    expect(event.output.blob.length).toBe(31_000);
    expect(fs.existsSync(event.output.blob.path)).toBe(true);
    const resumed = JSON.parse(lines[1]);
    expect(resumed.traceId).toBe(event.traceId);
    expect(resumed.sequence).toBe(event.sequence + 1);
    expect(resumed.usage.inputTokens).toBe(12);
  });

  it("protects pinned artifacts during TTL/capacity pruning and recovers orphaned tasks", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rubato-artifacts-"));
    tempDirs.push(root);
    const artifacts = new ArtifactStore(process.cwd(), "artifact-session", root);

    const makeTask = (taskId: string): TaskDetail => {
      const now = Date.now() - 10_000;
      return {
        taskId,
        agentId: `agent-${taskId}`,
        rootSessionId: "artifact-session",
        description: taskId,
        prompt: taskId,
        subagentType: "explore",
        dependency: "required",
        status: "completed",
        depth: 1,
        createdAt: now,
        endedAt: now,
        lastActivityAt: now,
        childCount: 0,
        artifacts: artifacts.paths(taskId),
      };
    };
    const finalize = (task: TaskDetail) => {
      const result: TaskResult = {
        taskId: task.taskId,
        agentId: task.agentId,
        status: "completed",
        summary: "done",
        reportPath: task.artifacts.report,
        resultPath: task.artifacts.result,
        transcriptPath: task.artifacts.transcript,
        usage: { inputTokens: 0, outputTokens: 0, toolCalls: 0 },
        endedAt: task.endedAt!,
      };
      artifacts.initializeTask(task);
      artifacts.finalizeTask(task, result, "done");
    };

    const pinned = makeTask("task-pinned");
    const removable = makeTask("task-removable");
    finalize(pinned);
    finalize(removable);
    artifacts.setPinned(pinned.taskId, true);
    const prune = artifacts.prune({ ttlMs: 0, softLimitBytes: 0 });
    expect(prune.removed).toContain(removable.taskId);
    expect(prune.removed).not.toContain(pinned.taskId);
    expect(artifacts.hasTask(pinned.taskId)).toBe(true);

    const orphan = makeTask("task-orphan");
    orphan.status = "running";
    orphan.endedAt = undefined;
    artifacts.initializeTask(orphan);
    const recovered = artifacts.recoverOrphaned();
    expect(recovered).toContainEqual(expect.objectContaining({
      taskId: orphan.taskId,
      status: "orphaned",
    }));
    expect(JSON.parse(fs.readFileSync(orphan.artifacts.result, "utf8")).status).toBe("orphaned");
  });
});
