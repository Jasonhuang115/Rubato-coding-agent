import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ControlPlaneStore } from "../src/runtime/control-plane/store.js";
import type { TaskDetail } from "../src/shared/core-types.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createStore(): ControlPlaneStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rubato-control-plane-"));
  tempDirs.push(dir);
  return new ControlPlaneStore(dir, { dbPath: path.join(dir, "state.sqlite3") });
}

function taskDetail(dir: string): TaskDetail {
  const taskDir = path.join(dir, "tasks", "task-1");
  return {
    taskId: "task-1",
    agentId: "agent-1",
    rootSessionId: "run-1",
    description: "content stays outside sqlite",
    prompt: "also outside sqlite",
    subagentType: "general",
    status: "queued",
    createdAt: 100,
    lastActivityAt: 100,
    currentActivity: "queued",
    artifacts: {
      taskDir,
      task: path.join(taskDir, "task.json"),
      report: path.join(taskDir, "report.md"),
      result: path.join(taskDir, "result.json"),
      transcript: path.join(taskDir, "transcript.jsonl"),
      coverage: path.join(taskDir, "coverage.json"),
      patch: path.join(taskDir, "changes.patch"),
    },
  };
}

describe("ControlPlaneStore", () => {
  it("keeps content-bearing columns out of the schema", () => {
    const store = createStore();
    const forbidden = new Set([
      "prompt",
      "response",
      "thinking",
      "tool_input",
      "tool_output",
      "report_content",
      "payload_json",
      "summary",
    ]);
    for (const table of ["conversations", "agent_runs", "subagent_tasks", "runtime_events"]) {
      expect(store.schemaColumns(table).filter((column) => forbidden.has(column))).toEqual([]);
    }
    store.close();
  });

  it("enforces one running root run per conversation", () => {
    const store = createStore();
    store.createRun({
      runId: "root-1",
      conversationId: "conversation-1",
      kind: "root",
      trigger: "user_message",
      provider: "test",
      model: "test-model",
    }, 100);
    expect(() => store.createRun({
      runId: "root-2",
      conversationId: "conversation-1",
      kind: "root",
      trigger: "subagent_terminal",
      provider: "test",
      model: "test-model",
    }, 101)).toThrow(/already has running root run/);
    store.finishRun("root-1", "finished", {}, 102);
    expect(() => store.createRun({
      runId: "root-2",
      conversationId: "conversation-1",
      kind: "root",
      trigger: "subagent_terminal",
      provider: "test",
      model: "test-model",
    }, 103)).not.toThrow();
    store.close();
  });

  it("rejects a live root lease and takes over an expired one", () => {
    const first = createStore();
    const second = new ControlPlaneStore(path.dirname(first.dbPath), { dbPath: first.dbPath });
    first.createRun({
      runId: "root-live",
      conversationId: "conversation-lease",
      kind: "root",
      trigger: "user_message",
      provider: "test",
      model: "test-model",
    }, 100);
    expect(() => second.createRun({
      runId: "root-blocked",
      conversationId: "conversation-lease",
      kind: "root",
      trigger: "user_message",
      provider: "test",
      model: "test-model",
    }, 1_000)).toThrow(/already has running root run/);
    expect(() => second.createRun({
      runId: "root-recovered",
      conversationId: "conversation-lease",
      kind: "root",
      trigger: "resume",
      provider: "test",
      model: "test-model",
    }, 20_000)).not.toThrow();
    expect(first.getRun("root-live")).toMatchObject({
      status: "failed",
      failureKind: "interrupted",
    });
    first.close();
    second.close();
  });

  it("claims tasks once and persists a unique terminal wake event", () => {
    const store = createStore();
    const detail = taskDetail(path.dirname(store.dbPath));
    store.upsertTask(detail, {
      conversationId: "conversation-1",
      originRunId: "run-1",
      timeoutMs: 60_000,
    }, 100);
    expect(store.claimTask("task-1", "worker-1", 200)).toBe(true);
    expect(store.claimTask("task-1", "worker-2", 200)).toBe(false);
    expect(store.heartbeatTask("task-1", "worker-1", 500, 300)).toBe(true);

    const first = store.createTerminalEvent("conversation-1", {
      taskId: "task-1",
      status: "finished",
      reportPath: detail.artifacts.report,
    }, 400);
    const second = store.createTerminalEvent("conversation-1", {
      taskId: "task-1",
      status: "finished",
      reportPath: detail.artifacts.report,
    }, 500);
    expect(second).toBe(first);
    expect(store.listPendingEvents("conversation-1")).toHaveLength(1);

    const claimed = store.claimEvents("conversation-1", "root-1", 600);
    expect(claimed.map((event) => event.eventId)).toEqual([first]);
    store.markEventsDelivered([first], "root-1", 700);
    expect(store.listPendingEvents("conversation-1")).toEqual([]);
    store.close();
  });

  it("recovers expired running tasks without consuming queued time", () => {
    const store = createStore();
    const detail = taskDetail(path.dirname(store.dbPath));
    store.upsertTask(detail, {
      conversationId: "conversation-1",
      originRunId: "run-1",
      timeoutMs: 60_000,
      accumulatedRuntimeMs: 1_500,
    }, 100);
    expect(store.claimTask("task-1", "dead-worker", 200, 100)).toBe(true);
    expect(store.recoverExpiredTasks("conversation-1", 301)).toEqual(["task-1"]);
    expect(store.getTask("task-1")).toMatchObject({
      status: "queued",
      accumulatedRuntimeMs: 1_500,
      attempt: 1,
    });
    store.close();
  });

  it("reconciles terminal artifacts and missing artifact failures idempotently", () => {
    const store = createStore();
    const detail = taskDetail(path.dirname(store.dbPath));
    fs.mkdirSync(detail.artifacts.taskDir, { recursive: true });
    fs.writeFileSync(detail.artifacts.report, "partial report", "utf8");
    store.upsertTask(detail, {
      conversationId: "conversation-1",
      originRunId: "run-1",
      timeoutMs: 60_000,
    }, 100);
    fs.writeFileSync(detail.artifacts.result, JSON.stringify({
      status: "finished",
      endedAt: 200,
    }), "utf8");
    expect(store.reconcileArtifacts("conversation-1")).toEqual({
      repaired: ["task-1"],
      missing: [],
    });
    expect(store.reconcileArtifacts("conversation-1")).toEqual({ repaired: [], missing: [] });
    fs.rmSync(detail.artifacts.result);
    expect(store.reconcileArtifacts("conversation-1")).toEqual({
      repaired: [],
      missing: ["task-1"],
    });
    expect(store.getTask("task-1")).toMatchObject({
      status: "failed",
      failureKind: "runtime_error",
      currentActivity: "failed",
    });
    expect(store.listPendingEvents("conversation-1")).toHaveLength(1);
    store.close();
  });
});
