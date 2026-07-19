// AgentRuntime — lifecycle container for agent execution.
// Wraps agentLoop() with:
//   - State machine tracking (IDLE → EXECUTING → VERIFYING → DONE)
//   - Event emission (step, tool, error, compaction events)
//   - Token usage tracking
//   - Abort mechanism

import { EventBus } from "./event-bus.js";
import { AgentStateMachine, AgentState } from "./state-machine.js";
import { Telemetry } from "./telemetry.js";
import { AuditLog } from "../security/audit-log.js";
import type { AgentConfig, StreamRenderer, ConfirmDecision, TokenUsage } from "../shared/core-types.js";
import type { AgentEvent } from "../agent/loop.js";
import type { SessionManager } from "./session/manager.js";

export interface RuntimeOptions {
  config: AgentConfig;
  workingDir: string;
  prompt: string;
  renderer: StreamRenderer;
  sessionId?: string;
  sessionManager?: SessionManager;
  onConfirmTool?: (toolName: string, input: Record<string, unknown>) => Promise<ConfirmDecision>;
  resumeSummary?: string;
}

export class AgentRuntime {
  readonly eventBus: EventBus;
  readonly stateMachine: AgentStateMachine;
  readonly options: RuntimeOptions;
  readonly telemetry: Telemetry;
  readonly auditLog: AuditLog;

  private _totalTokens: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  private _totalSteps = 0;
  private _startTime = 0;
  private _unsubTelemetry?: () => void;

  constructor(options: RuntimeOptions) {
    this.options = options;
    this.eventBus = new EventBus();
    this.stateMachine = new AgentStateMachine(this.eventBus);
    this.telemetry = new Telemetry();
    this.auditLog = new AuditLog(1000);

    // Wire telemetry to event bus
    this._unsubTelemetry = this.telemetry.attach(this.eventBus);

    // Wire audit log: record security decisions
    this.eventBus.on("security.decision", (e) => {
      if (e.type === "security.decision") {
        this.auditLog.record({
          sessionId: this.options.sessionId ?? "unknown",
          toolName: e.tool,
          inputPreview: "",
          verdict: e.verdict,
          risk: e.risk,
          reason: e.reason,
          outcome: e.verdict === "deny" ? "blocked" : "allowed",
          latencyMs: 0,
          workspaceRoot: this.options.workingDir,
        });
      }
    });
  }

  get totalTokens(): TokenUsage {
    return { ...this._totalTokens };
  }

  get totalSteps(): number {
    return this._totalSteps;
  }

  get elapsedMs(): number {
    return this._startTime > 0 ? Date.now() - this._startTime : 0;
  }

  /**
   * Run the agent loop and return a summary.
   * Emits events for every significant lifecycle moment.
   */
  async run(): Promise<{ totalSteps: number; totalTokens: TokenUsage }> {
    const { agentLoop } = await import("../agent/loop.js");

    this._startTime = Date.now();
    this.stateMachine.reset();
    this.stateMachine.transition(AgentState.EXECUTING, "Starting agent loop");

    const { config, workingDir, prompt, renderer, sessionId, sessionManager, onConfirmTool, resumeSummary } = this.options;
    const taskId = sessionId ?? "unknown";

    this.eventBus.emit({
      type: "task.started",
      taskId,
      timestamp: Date.now(),
    });

    try {
      for await (const event of agentLoop({
        config,
        workingDir,
        prompt,
        renderer,
        sessionId,
        sessionManager,
        onConfirmTool,
        resumeSummary,
      })) {
        // Map agent events to runtime events
        this.dispatchEvent(event, taskId);
      }
    } catch (err) {
      this.stateMachine.transition(AgentState.ERROR, String(err));
      this.eventBus.emit({
        type: "error",
        timestamp: Date.now(),
        error: String(err),
        context: "agent_runtime",
        recoverable: false,
      });
    }

    this.stateMachine.transition(AgentState.DONE, "Agent loop completed");

    this.eventBus.emit({
      type: "task.completed",
      taskId,
      timestamp: Date.now(),
      totalSteps: this._totalSteps,
      totalTokens: this._totalTokens,
    });

    // Log telemetry summary
    const snap = this.telemetry.snapshot();
    if (snap.totalSteps > 0) {
      this.eventBus.emit({
        type: "compaction.triggered", // reuse — actually a telemetry report
        timestamp: Date.now(),
        reason: `Telemetry: ${snap.totalSteps} steps, ${snap.totalToolCalls} tools, ${snap.totalErrors} errors, ` +
          `${snap.totalTokens.input + snap.totalTokens.output} tokens, ${snap.modelCalls} model calls`,
        messagesBefore: 0, messagesAfter: 0,
      });
    }

    return { totalSteps: this._totalSteps, totalTokens: this._totalTokens };
  }

  /** Clean up event bus listeners. Call when the runtime is no longer needed. */
  dispose(): void {
    this._unsubTelemetry?.();
  }

  /**
   * Map AgentEvent → RuntimeEvent + update counters.
   */
  private dispatchEvent(event: AgentEvent, taskId: string): void {
    switch (event.type) {
      case "turn_start":
        this.eventBus.emit({
          type: "step.started",
          stepIndex: event.turn,
          timestamp: Date.now(),
        });
        break;

      case "turn_end":
        this._totalSteps++;
        if (event.usage) {
          this._totalTokens.inputTokens += event.usage.input;
          this._totalTokens.outputTokens += event.usage.output;
        }
        this.eventBus.emit({
          type: "step.completed",
          stepIndex: this._totalSteps,
          timestamp: Date.now(),
          usage: {
            inputTokens: event.usage?.input ?? 0,
            outputTokens: event.usage?.output ?? 0,
          },
          latencyMs: 0,
        });
        break;

      case "tool_result":
        this.eventBus.emit({
          type: "tool.executed",
          timestamp: Date.now(),
          tool: event.name,
          input: {},
          output: event.result.slice(0, 500), // preview only
          isError: event.isError,
          latencyMs: 0,
        });
        break;

      case "compacting":
        this.eventBus.emit({
          type: "compaction.triggered",
          timestamp: Date.now(),
          reason: event.reason,
          messagesBefore: 0, // approximate
          messagesAfter: 0,
        });
        break;

      case "error":
        this.eventBus.emit({
          type: "error",
          timestamp: Date.now(),
          error: event.message,
          context: "agent_loop",
          recoverable: event.retryable,
        });
        break;

      case "done":
      case "warning":
      case "thinking":
      case "text":
      case "tool_call":
      case "waiting_for_input":
        // Pass through for now — these are user-facing
        break;
    }
  }
}
