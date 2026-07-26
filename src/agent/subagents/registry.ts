import type { AgentConfig } from "../../shared/core-types.js";
import { SubagentRuntime } from "./subagent-runtime.js";
import { ArtifactStore } from "./artifact-store.js";
import { TraceSink } from "./trace-sink.js";
import path from "path";
import type { TaskResult } from "../../shared/core-types.js";

export class ProcessSubagentRegistry {
  private readonly runtimes = new Map<string, SubagentRuntime>();

  get(rootSessionId: string): SubagentRuntime | undefined {
    return this.runtimes.get(rootSessionId);
  }

  getOrCreate(
    rootSessionId: string,
    workingDir: string,
    config: AgentConfig,
  ): SubagentRuntime {
    const existing = this.runtimes.get(rootSessionId);
    if (existing) return existing;
    const runtime = new SubagentRuntime(rootSessionId, workingDir, config);
    this.runtimes.set(rootSessionId, runtime);
    return runtime;
  }

  remove(rootSessionId: string, orphanRunning = false): void {
    const runtime = this.runtimes.get(rootSessionId);
    if (orphanRunning) runtime?.markRunningTasksOrphaned();
    this.runtimes.delete(rootSessionId);
  }

  list(): SubagentRuntime[] {
    return [...this.runtimes.values()];
  }

  recoverProjectOrphans(workingDir: string): TaskResult[] {
    const recovered = ArtifactStore.recoverProjectOrphans(workingDir);
    for (const result of recovered) {
      const runDir = path.dirname(path.dirname(path.dirname(result.resultPath)));
      const rootSessionId = path.basename(runDir);
      const store = new ArtifactStore(workingDir, rootSessionId);
      const trace = new TraceSink(store);
      trace.append({
        type: "task_recovered_orphaned",
        sessionId: rootSessionId,
        taskId: result.taskId,
        agentId: result.agentId,
        resultPath: result.resultPath,
      });
      store.refreshTranscript(result.taskId);
    }
    return recovered;
  }
}

export const processSubagentRegistry = new ProcessSubagentRegistry();
