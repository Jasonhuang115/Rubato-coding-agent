import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConversationInbox } from "../src/agent/subagents/conversation-inbox.js";
import { ControlPlaneStore } from "../src/runtime/control-plane/store.js";
import type { TaskResult } from "../src/shared/core-types.js";

function result(taskId: string): TaskResult {
  return {
    taskId,
    agentId: `agent-${taskId}`,
    status: "finished",
    reportPath: `/tmp/${taskId}/report.md`,
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

  it("acknowledges a persisted terminal event consumed through wait", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rubato-inbox-"));
    const store = new ControlPlaneStore(dir, { dbPath: path.join(dir, "state.sqlite3") });
    const inbox = new ConversationInbox("conversation-1", store);
    inbox.deliver(result("task-a"));
    expect((await inbox.wait()).taskIds).toEqual(["task-a"]);
    expect(store.listPendingEvents("conversation-1")).toEqual([]);
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
