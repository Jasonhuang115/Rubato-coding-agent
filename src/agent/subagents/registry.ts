import type { AgentConfig } from "../../shared/core-types.js";
import { SubagentRuntime } from "./subagent-runtime.js";

export class ProcessSubagentRegistry {
  private readonly runtimes = new Map<string, SubagentRuntime>();

  get(rootSessionId: string): SubagentRuntime | undefined {
    return this.runtimes.get(rootSessionId);
  }

  getOrCreate(
    conversationId: string,
    workingDir: string,
    config: AgentConfig,
    originRunId = conversationId,
  ): SubagentRuntime {
    const existing = this.runtimes.get(conversationId);
    if (existing) return existing;
    const runtime = new SubagentRuntime(
      conversationId,
      workingDir,
      config,
      undefined,
      originRunId,
    );
    this.runtimes.set(conversationId, runtime);
    return runtime;
  }

  remove(rootSessionId: string, orphanRunning = false): void {
    const runtime = this.runtimes.get(rootSessionId);
    if (orphanRunning) runtime?.pauseAll();
    this.runtimes.delete(rootSessionId);
  }

  list(): SubagentRuntime[] {
    return [...this.runtimes.values()];
  }

}

export const processSubagentRegistry = new ProcessSubagentRegistry();
