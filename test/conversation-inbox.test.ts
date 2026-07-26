import { describe, expect, it } from "vitest";
import { ConversationInbox } from "../src/agent/subagents/conversation-inbox.js";
import type { TaskResult } from "../src/shared/core-types.js";

function result(taskId: string): TaskResult {
  return {
    taskId,
    agentId: `agent-${taskId}`,
    status: "completed",
    summary: `${taskId} complete`,
    reportPath: `/tmp/${taskId}/report.md`,
    resultPath: `/tmp/${taskId}/result.json`,
    transcriptPath: `/tmp/${taskId}/transcript.jsonl`,
    usage: { inputTokens: 1, outputTokens: 1, toolCalls: 0 },
    endedAt: Date.now(),
  };
}

describe("ConversationInbox acknowledgement", () => {
  it("suppresses a completion acknowledged before its delivery microtask flushes", async () => {
    const inbox = new ConversationInbox("root");
    expect(inbox.deliver(result("task-a"))).toBe(true);
    expect(inbox.acknowledge(["task-a"])).toEqual(["task-a"]);

    await Promise.resolve();

    expect(inbox.drain()).toEqual([]);
    expect(inbox.deliver(result("task-a"))).toBe(false);
  });

  it("removes only acknowledged tasks from a grouped completion event", async () => {
    const inbox = new ConversationInbox("root");
    inbox.deliver(result("task-a"));
    inbox.deliver(result("task-b"));
    await Promise.resolve();

    inbox.acknowledge(["task-a"]);

    const events = inbox.drain();
    expect(events).toHaveLength(1);
    expect(events[0].taskIds).toEqual(["task-b"]);
    expect(events[0].results.map((item) => item.taskId)).toEqual(["task-b"]);
  });

  it("consumes a waited event exactly once", async () => {
    const inbox = new ConversationInbox("root");
    inbox.deliver(result("task-a"));

    const event = await inbox.wait();

    expect(event.taskIds).toEqual(["task-a"]);
    expect(inbox.drain()).toEqual([]);
    expect(inbox.deliver(result("task-a"))).toBe(false);
  });
});
