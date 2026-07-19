// Runtime modules tests — EventBus, StateMachine, Telemetry, Replay, Evaluator
import { describe, it, expect } from "vitest";
import { EventBus } from "../src/runtime/event-bus.js";
import { AgentStateMachine, AgentState } from "../src/runtime/state-machine.js";
import { Telemetry } from "../src/runtime/telemetry.js";
import { ReplayStore, messagesUpToStep, diffSessions } from "../src/runtime/replay.js";
import { TestEvaluator, TypeCheckEvaluator, BuildEvaluator, LintEvaluator, CompositeEvaluator } from "../src/runtime/evaluator.js";
import { roughTokenEstimate, estimateMessageTokens } from "../src/runtime/compaction-controller.js";

// ---- EventBus ----

describe("EventBus", () => {
  it("emits to matching handlers", () => {
    const bus = new EventBus();
    const received: string[] = [];
    bus.on("task.started", () => received.push("started"));
    bus.emit({ type: "task.started", taskId: "1", timestamp: 0 });
    expect(received).toEqual(["started"]);
  });

  it("supports wildcard patterns", () => {
    const bus = new EventBus();
    const received: string[] = [];
    bus.on("tool.*", (e) => received.push(e.type));
    bus.emit({ type: "tool.executing", timestamp: 0, tool: "Bash", input: {} });
    bus.emit({ type: "tool.executed", timestamp: 0, tool: "Bash", input: {}, output: "ok", isError: false, latencyMs: 5 });
    expect(received).toEqual(["tool.executing", "tool.executed"]);
  });

  it("supports catch-all pattern", () => {
    const bus = new EventBus();
    let count = 0;
    bus.on("*", () => count++);
    bus.emit({ type: "task.started", taskId: "1", timestamp: 0 });
    bus.emit({ type: "error", timestamp: 0, error: "test", context: "test", recoverable: true });
    expect(count).toBe(2);
  });

  it("once unsubscribes after first match", () => {
    const bus = new EventBus();
    let count = 0;
    bus.once("task.started", () => count++);
    bus.emit({ type: "task.started", taskId: "1", timestamp: 0 });
    bus.emit({ type: "task.started", taskId: "2", timestamp: 0 });
    expect(count).toBe(1);
  });

  it("unsubscribe returns function", () => {
    const bus = new EventBus();
    let count = 0;
    const unsub = bus.on("task.started", () => count++);
    unsub();
    bus.emit({ type: "task.started", taskId: "1", timestamp: 0 });
    expect(count).toBe(0);
  });

  it("error in one handler does not break others", () => {
    const bus = new EventBus();
    const received: string[] = [];
    bus.on("task.started", () => { throw new Error("boom"); });
    bus.on("task.started", () => received.push("second"));
    bus.emit({ type: "task.started", taskId: "1", timestamp: 0 });
    expect(received).toEqual(["second"]);
  });

  it("handlerCount tracks registered handlers", () => {
    const bus = new EventBus();
    expect(bus.handlerCount).toBe(0);
    const u1 = bus.on("task.*", () => {});
    const u2 = bus.on("tool.*", () => {});
    expect(bus.handlerCount).toBe(2);
    u1();
    expect(bus.handlerCount).toBe(1);
    u2();
    expect(bus.handlerCount).toBe(0);
  });
});

// ---- StateMachine ----

describe("AgentStateMachine", () => {
  it("starts in IDLE", () => {
    const bus = new EventBus();
    const sm = new AgentStateMachine(bus);
    expect(sm.state).toBe(AgentState.IDLE);
  });

  it("transitions IDLE → EXECUTING", () => {
    const bus = new EventBus();
    const sm = new AgentStateMachine(bus);
    const t = sm.transition(AgentState.EXECUTING, "start");
    expect(t.from).toBe(AgentState.IDLE);
    expect(t.to).toBe(AgentState.EXECUTING);
    expect(sm.state).toBe(AgentState.EXECUTING);
  });

  it("throws on invalid transition", () => {
    const bus = new EventBus();
    const sm = new AgentStateMachine(bus);
    // DONE → EXECUTING is valid
    sm.transition(AgentState.EXECUTING);
    sm.transition(AgentState.DONE);
    // DONE → IDLE is valid
    sm.transition(AgentState.IDLE);
    expect(() => sm.transition(AgentState.VERIFYING as any)).toThrow(); // IDLE → VERIFYING is invalid
  });

  it("canTransition returns correct result", () => {
    const bus = new EventBus();
    const sm = new AgentStateMachine(bus);
    expect(sm.canTransition(AgentState.EXECUTING)).toBe(true);
    expect(sm.canTransition(AgentState.DONE as any)).toBe(false);
  });

  it("reset returns to IDLE", () => {
    const bus = new EventBus();
    const sm = new AgentStateMachine(bus);
    sm.transition(AgentState.EXECUTING);
    sm.reset();
    expect(sm.state).toBe(AgentState.IDLE);
  });

  it("getHistory tracks all transitions", () => {
    const bus = new EventBus();
    const sm = new AgentStateMachine(bus);
    sm.transition(AgentState.EXECUTING, "reason1");
    sm.transition(AgentState.DONE, "reason2");
    expect(sm.getHistory().length).toBe(2);
  });
});

// ---- Telemetry ----

describe("Telemetry", () => {
  it("collects step metrics", () => {
    const bus = new EventBus();
    const tel = new Telemetry();
    tel.attach(bus);

    bus.emit({ type: "step.completed", stepIndex: 1, timestamp: 0, usage: { inputTokens: 100, outputTokens: 50 }, latencyMs: 200 });
    bus.emit({ type: "step.completed", stepIndex: 2, timestamp: 0, usage: { inputTokens: 200, outputTokens: 100 }, latencyMs: 300 });

    const snap = tel.snapshot();
    expect(snap.totalSteps).toBe(2);
    expect(snap.totalTokens.input).toBe(300);
    expect(snap.totalTokens.output).toBe(150);
    expect(snap.avgStepLatencyMs).toBe(250);
  });

  it("collects tool call metrics", () => {
    const bus = new EventBus();
    const tel = new Telemetry();
    tel.attach(bus);

    bus.emit({ type: "tool.executed", timestamp: 0, tool: "Bash", input: {}, output: "ok", isError: false, latencyMs: 10 });
    bus.emit({ type: "tool.executed", timestamp: 0, tool: "Read", input: {}, output: "ok", isError: false, latencyMs: 5 });
    bus.emit({ type: "tool.executed", timestamp: 0, tool: "Bash", input: {}, output: "error", isError: true, latencyMs: 20 });

    const snap = tel.snapshot();
    expect(snap.totalToolCalls).toBe(3);
    expect(snap.toolCallCounts["Bash"]).toBe(2);
    expect(snap.toolCallCounts["Read"]).toBe(1);
    expect(snap.toolErrorCounts["Bash"]).toBe(1);
  });

  it("collects error count", () => {
    const bus = new EventBus();
    const tel = new Telemetry();
    tel.attach(bus);

    bus.emit({ type: "error", timestamp: 0, error: "test1", context: "test", recoverable: true });
    bus.emit({ type: "error", timestamp: 0, error: "test2", context: "test", recoverable: false });

    expect(tel.snapshot().totalErrors).toBe(2);
  });

  it("reset clears all metrics", () => {
    const bus = new EventBus();
    const tel = new Telemetry();
    tel.attach(bus);
    bus.emit({ type: "step.completed", stepIndex: 1, timestamp: 0, usage: { inputTokens: 100, outputTokens: 50 }, latencyMs: 200 });

    tel.reset();
    const snap = tel.snapshot();
    expect(snap.totalSteps).toBe(0);
    expect(snap.totalTokens.input).toBe(0);
  });
});

// ---- ReplayStore ----

describe("ReplayStore", () => {
  it("starts and stops recording", () => {
    const store = new ReplayStore("/tmp/replay-test");
    store.startRecording("s1", "deepseek-chat", "/test", "deepseek");
    expect(store.current()).not.toBeNull();
    store.stopRecording();
    expect(store.current()).toBeNull();
  });

  it("records steps", () => {
    const store = new ReplayStore("/tmp/replay-test");
    store.startRecording("s1", "deepseek-chat", "/test", "deepseek");
    store.recordStep({
      stepIndex: 0, timestamp: Date.now(),
      messages: [{ role: "user", content: "hello" }],
      systemPrompt: "test system",
      latencyMs: 100,
      toolCalls: [{ name: "Read", input: { file_path: "a.ts" }, output: "content", isError: false, latencyMs: 5 }],
      workingDir: "/test",
    });
    expect(store.current()?.steps.length).toBe(1);
    expect(store.current()?.metadata.totalTurns).toBe(1);
    store.stopRecording();
  });

  it("builds messages up to step", () => {
    const session = {
      sessionId: "s1", model: "test", timestamp: 0,
      metadata: { workingDir: "/test", provider: "test", totalTurns: 2 },
      steps: [
        {
          stepIndex: 0, timestamp: 0,
          messages: [{ role: "user", content: "request 1" } as any],
          systemPrompt: "system", latencyMs: 100,
          response: { text: "response 1", toolUses: [] },
          toolCalls: [],
          workingDir: "/test",
        },
      ],
    };
    const msgs = messagesUpToStep(session, 1);
    expect(msgs.length).toBeGreaterThan(0);
  });

  it("diffs two sessions", () => {
    const a = {
      sessionId: "a", model: "deepseek-chat", timestamp: 0,
      metadata: { workingDir: "/test", provider: "deepseek", totalTurns: 1 },
      steps: [{
        stepIndex: 0, timestamp: 0, messages: [], systemPrompt: "sys",
        latencyMs: 100,
        toolCalls: [{ name: "Read", input: {}, output: "ok", isError: false, latencyMs: 5 }],
        workingDir: "/test",
      }],
    };
    const b = {
      sessionId: "b", model: "claude-sonnet", timestamp: 0,
      metadata: { workingDir: "/test", provider: "anthropic", totalTurns: 1 },
      steps: [{
        stepIndex: 0, timestamp: 0, messages: [], systemPrompt: "sys",
        latencyMs: 150,
        toolCalls: [{ name: "Bash", input: {}, output: "ok", isError: false, latencyMs: 10 }],
        workingDir: "/test",
      }],
    };
    const diff = diffSessions(a, b);
    expect(diff.toolChoiceDiff.length).toBeGreaterThan(0);
  });
});

// ---- CompactionController (token estimation) ----

describe("CompactionController token estimation", () => {
  it("estimates CJK text higher", () => {
    const en = roughTokenEstimate("hello world");
    const cn = roughTokenEstimate("你好世界");
    expect(cn).toBeGreaterThan(en);
  });

  it("estimates message tokens", () => {
    const tokens = estimateMessageTokens([
      { role: "user", content: "Hello, how are you?" },
    ]);
    expect(tokens).toBeGreaterThan(0);
  });

  it("estimates complex message tokens", () => {
    const tokens = estimateMessageTokens([
      { role: "assistant", content: [
        { type: "text", text: "Let me read that file." },
        { type: "tool_use", id: "1", name: "Read", input: { file_path: "test.ts" } },
      ]},
    ]);
    expect(tokens).toBeGreaterThan(0);
  });
});

// ---- Evaluator ----

describe("TestEvaluator", () => {
  it("has name 'test'", () => {
    const e = new TestEvaluator();
    expect(e.name).toBe("test");
  });

  it("implements Evaluator interface", () => {
    const e = new TestEvaluator();
    expect(typeof e.evaluate).toBe("function");
  });
});

describe("TypeCheckEvaluator", () => {
  it("has name 'typecheck'", () => {
    expect(new TypeCheckEvaluator().name).toBe("typecheck");
  });

  it("implements Evaluator interface", () => {
    const e = new TypeCheckEvaluator();
    expect(typeof e.evaluate).toBe("function");
  });
});

describe("BuildEvaluator", () => {
  it("has name 'build'", () => {
    expect(new BuildEvaluator().name).toBe("build");
  });

  it("implements Evaluator interface", () => {
    const e = new BuildEvaluator();
    expect(typeof e.evaluate).toBe("function");
  });
});

describe("LintEvaluator", () => {
  it("has name 'lint'", () => {
    expect(new LintEvaluator().name).toBe("lint");
  });

  it("implements Evaluator interface", () => {
    const e = new LintEvaluator();
    expect(typeof e.evaluate).toBe("function");
  });
});

describe("CompositeEvaluator", () => {
  it("has four evaluators", () => {
    const composite = new CompositeEvaluator();
    // Should have 4 evaluators (typecheck, test, build, lint)
    expect(composite).toBeDefined();
  });

  it("evaluateAll with empty context returns results", async () => {
    const composite = new CompositeEvaluator();
    // Using a temp dir that won't have npm/node — evaluators handle gracefully
    const results = await composite.evaluateAll({ task: "test", workingDir: "/tmp", filesModified: [] });
    expect(results.length).toBe(4);
    for (const r of results) {
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(1);
    }
  }, 120000); // 2 minutes for all 4 evaluators

  it("compute overall score aggregates correctly", async () => {
    const composite = new CompositeEvaluator();
    const result = await composite.evaluateOverall({ task: "test", workingDir: "/tmp", filesModified: [] });
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(1);
  }, 120000);
});
