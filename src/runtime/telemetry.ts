// Telemetry — aggregates runtime metrics from EventBus events.
// Tracks: step counts, tool usage, error rates, latency percentiles, model usage.
// All metrics are in-memory and session-scoped. No external service dependency.

import type { EventBus } from "./event-bus.js";
import type { RuntimeEvent } from "./event-bus.js";

export interface TelemetrySnapshot {
  totalSteps: number;
  totalErrors: number;
  totalToolCalls: number;
  toolCallCounts: Record<string, number>;
  toolErrorCounts: Record<string, number>;
  avgStepLatencyMs: number;
  totalTokens: { input: number; output: number };
  modelCalls: number;
}

export class Telemetry {
  private steps = 0;
  private errors = 0;
  private toolCalls = 0;
  private toolCounts: Record<string, number> = {};
  private toolErrors: Record<string, number> = {};
  private stepLatencies: number[] = [];
  private totalInputTokens = 0;
  private totalOutputTokens = 0;
  private modelCalls = 0;

  /**
   * Attach to an EventBus to start collecting metrics.
   * Returns an unsubscribe function.
   */
  attach(eventBus: EventBus): () => void {
    const unsubs: Array<() => void> = [];

    unsubs.push(eventBus.on("step.completed", (e) => {
      if (e.type === "step.completed") {
        this.steps++;
        this.stepLatencies.push(e.latencyMs);
        this.totalInputTokens += e.usage.inputTokens;
        this.totalOutputTokens += e.usage.outputTokens;
      }
    }));

    unsubs.push(eventBus.on("tool.executed", (e) => {
      if (e.type === "tool.executed") {
        this.toolCalls++;
        this.toolCounts[e.tool] = (this.toolCounts[e.tool] ?? 0) + 1;
        if (e.isError) {
          this.toolErrors[e.tool] = (this.toolErrors[e.tool] ?? 0) + 1;
        }
      }
    }));

    unsubs.push(eventBus.on("model.invoked", () => {
      this.modelCalls++;
    }));

    unsubs.push(eventBus.on("error", () => {
      this.errors++;
    }));

    return () => unsubs.forEach((u) => u());
  }

  /**
   * Get a snapshot of current metrics.
   */
  snapshot(): TelemetrySnapshot {
    const sortedLatencies = [...this.stepLatencies].sort((a, b) => a - b);
    const avg = this.stepLatencies.length > 0
      ? this.stepLatencies.reduce((a, b) => a + b, 0) / this.stepLatencies.length
      : 0;

    return {
      totalSteps: this.steps,
      totalErrors: this.errors,
      totalToolCalls: this.toolCalls,
      toolCallCounts: { ...this.toolCounts },
      toolErrorCounts: { ...this.toolErrors },
      avgStepLatencyMs: Math.round(avg),
      totalTokens: { input: this.totalInputTokens, output: this.totalOutputTokens },
      modelCalls: this.modelCalls,
    };
  }

  /**
   * Reset all metrics.
   */
  reset(): void {
    this.steps = 0;
    this.errors = 0;
    this.toolCalls = 0;
    this.toolCounts = {};
    this.toolErrors = {};
    this.stepLatencies = [];
    this.totalInputTokens = 0;
    this.totalOutputTokens = 0;
    this.modelCalls = 0;
  }
}
