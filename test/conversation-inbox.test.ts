import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ArtifactStore } from "../src/agent/subagents/artifact-store.js";
import { ConversationInbox } from "../src/agent/subagents/conversation-inbox.js";
import type { TaskDetail, TaskResult } from "../src/shared/core-types.js";

function result(taskId: string, reportPath = `/tmp/${taskId}/report.md`): TaskResult {
  return {
    taskId,
    agentId: `agent-${taskId}`,
    status: "finished",
    reportPath,
    resultPath: `/tmp/${taskId}/result.json`,
    transcriptPath: `/tmp/${taskId}/transcript.jsonl`,
    coveragePath: `/tmp/${taskId}/coverage.json`,
    usage: { inputTokens: 1, outputTokens: 1, toolCalls: 0 },
    endedAt: Date.now(),
  };
}

describe("ConversationInbox terminal delivery", () => {
  it("batches same-tick terminal changes with minimal payloads", async () => {
    const inbox = new ConversationInbox("root");
    inbox.deliver(result("task-a"));
    inbox.deliver(result("task-b"));
    await Promise.resolve();
    const [event] = inbox.drain();
    expect(event.taskIds).toEqual(["task-a", "task-b"]);
    expect(Object.keys(event.results[0]).sort()).toEqual([
      "error", "reportPath", "status", "taskId",
    ]);
  });

  it("delivers each task once and wait consumes one event", async () => {
    const inbox = new ConversationInbox("root");
    expect(inbox.deliver(result("task-a"))).toBe(true);
    const event = await inbox.wait();
    expect(event.taskIds).toEqual(["task-a"]);
    expect(inbox.drain()).toEqual([]);
    expect(inbox.deliver(result("task-a"))).toBe(false);
  });

  it("restores unnotified results from the task directory and marks them notified", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "rubato-inbox-home-"));
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "rubato-inbox-proj-"));
    const previous = process.env.RUBATO_HOME;
    process.env.RUBATO_HOME = home;
    try {
      const artifacts = new ArtifactStore(project, "conversation-1");
      const now = Date.now();
      const task: TaskDetail = {
        taskId: "task-a",
        agentId: "agent-a",
        rootSessionId: "conversation-1",
        description: "inbox",
        prompt: "prompt",
        subagentType: "general",
        status: "finished",
        createdAt: now,
        lastActivityAt: now,
        artifacts: artifacts.paths("task-a"),
      };
      artifacts.initializeTask(task, { timeoutMs: 1_000 });
      artifacts.finalizeTask(task, result("task-a", task.artifacts.report));

      const inbox = new ConversationInbox("conversation-1", artifacts);
      expect((await inbox.wait()).taskIds).toEqual(["task-a"]);
      expect(fs.existsSync(path.join(task.artifacts.taskDir, "notified"))).toBe(true);

      const again = new ConversationInbox("conversation-1", artifacts);
      expect(again.drain()).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.RUBATO_HOME;
      else process.env.RUBATO_HOME = previous;
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(project, { recursive: true, force: true });
    }
  });
});
