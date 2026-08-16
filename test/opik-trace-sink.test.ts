import { describe, expect, it, vi } from "vitest";
import { OpikTraceSink } from "../src/agent/subagents/opik-trace-sink.js";

function fakeClient() {
  const spans = new Map<string, ReturnType<typeof span>>();
  const traces: Array<Record<string, unknown>> = [];
  const traceObjects: Array<ReturnType<typeof trace>> = [];
  const client = {
    trace: vi.fn((data: Record<string, unknown>) => {
      traces.push(data);
      const value = trace(spans);
      traceObjects.push(value);
      return value;
    }),
    flush: vi.fn(async () => {}),
  };
  return { client, traces, traceObjects, spans };
}

function span() {
  return {
    update: vi.fn().mockReturnThis(),
    end: vi.fn().mockReturnThis(),
    span: vi.fn(),
    score: vi.fn(),
    data: { id: "span" },
  };
}

function trace(spans: Map<string, ReturnType<typeof span>>) {
  return {
    update: vi.fn().mockReturnThis(),
    end: vi.fn().mockReturnThis(),
    score: vi.fn(),
    data: { id: "trace" },
    span: vi.fn((data: Record<string, unknown>) => {
      const value = span();
      spans.set(String(data.name), value);
      return value;
    }),
  };
}

describe("OpikTraceSink", () => {
  it("maps root runs and tool calls without exposing local absolute paths", async () => {
    const fixture = fakeClient();
    const sink = new OpikTraceSink(fixture.client as never);
    sink.append({
      type: "root_session_started",
      sessionId: "run-1",
      conversationId: "conversation-1",
      runId: "run-1",
      prompt: "inspect the repository",
      reportPath: "/Users/example/private/report.md",
      sequence: 1,
    });
    sink.append({
      type: "tool_started",
      sessionId: "run-1",
      conversationId: "conversation-1",
      runId: "run-1",
      scope: "root",
      toolId: "tool-1",
      tool: "Read",
      input: { path: "/Users/example/private/file.ts" },
      sequence: 2,
    });
    sink.append({
      type: "tool_completed",
      sessionId: "run-1",
      runId: "run-1",
      toolId: "tool-1",
      output: "ok",
      sequence: 3,
    });
    sink.append({
      type: "root_session_ended",
      sessionId: "run-1",
      conversationId: "conversation-1",
      runId: "run-1",
      reason: "end_turn",
      sequence: 4,
    });
    await sink.flush();

    expect(fixture.traces[0]).toMatchObject({
      name: "rubato.root_run",
      threadId: "conversation-1",
    });
    expect(JSON.stringify(fixture.client.trace.mock.calls)).not.toContain("/Users/example");
    expect(fixture.spans.get("Read")?.end).toHaveBeenCalledOnce();
    expect(fixture.traceObjects[0].end).toHaveBeenCalledOnce();
    expect(fixture.client.flush).toHaveBeenCalledOnce();
  });

  it("replaces oversized remote text with bounded evidence", () => {
    const fixture = fakeClient();
    const sink = new OpikTraceSink(fixture.client as never);
    sink.append({
      type: "root_session_started",
      sessionId: "run-1",
      prompt: "x".repeat(9_000),
    });
    const serialized = JSON.stringify(fixture.traces[0]);
    expect(serialized).toContain('"length":9000');
    expect(serialized.length).toBeLessThan(2_000);
  });

  it("never exports private reasoning and tolerates an unavailable backend", async () => {
    const fixture = fakeClient();
    fixture.client.flush.mockRejectedValueOnce(new Error("offline"));
    const sink = new OpikTraceSink(fixture.client as never);
    sink.append({
      type: "thinking_delta",
      sessionId: "run-1",
      thinking: "private chain of thought",
    });
    sink.append({
      type: "root_session_started",
      sessionId: "run-1",
      prompt: "visible",
      reasoning: "also private",
    });
    await expect(sink.flush()).resolves.toBeUndefined();
    expect(JSON.stringify(fixture.client.trace.mock.calls)).not.toContain("private");
    expect(fixture.client.trace).toHaveBeenCalledOnce();
  });
});
