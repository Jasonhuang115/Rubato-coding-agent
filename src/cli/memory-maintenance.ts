// Background memory maintenance for the CLI.
//
// Two jobs run once per start, off the critical path of the user's first turn:
//
//   1. Bootstrap repository facts. Deterministic, model-free, and cheap when the
//      checkout has not changed since the last scan.
//   2. Drain the durable Dream queue. This is the only place in normal operation
//      that spends model calls on memory, so it is capped, budgeted, cancellable,
//      and reports what it did instead of mutating memory silently.
//
// Nothing here is awaited by the agent loop and nothing here throws: a failed
// maintenance pass must never take down a session.

import type { AgentConfig } from "../shared/core-types.js";
import { createProvider } from "../model/router.js";
import {
  bootstrapProjectMemory,
  looksLikeProject,
  type BootstrapProjectMemoryResult,
} from "../memory-files/bootstrap.js";
import {
  pendingDreamSummary,
  runQueuedDreams,
  type DreamRunnerResult,
} from "../memory-files/dream-runner.js";

export interface MemoryMaintenanceOptions {
  workingDir: string;
  config: AgentConfig;
  rootDir?: string;
  signal?: AbortSignal;
  /** Defaults to console reporting; tests pass a collector. */
  report?: (message: string) => void;
}

export interface MemoryMaintenanceResult {
  bootstrap?: BootstrapProjectMemoryResult;
  dreams?: DreamRunnerResult;
  skipped: string[];
}

export interface MemoryMaintenanceHandle {
  readonly done: Promise<MemoryMaintenanceResult>;
  cancel(): void;
}

/**
 * Starts maintenance without blocking the caller. The returned handle lets the
 * CLI stop the pass when the user exits mid-run.
 */
export function startMemoryMaintenance(
  options: MemoryMaintenanceOptions,
): MemoryMaintenanceHandle {
  const controller = new AbortController();
  const signal = options.signal
    ? anySignal([options.signal, controller.signal])
    : controller.signal;
  const done = runMemoryMaintenance({ ...options, signal });
  return {
    done,
    cancel: () => controller.abort(),
  };
}

export async function runMemoryMaintenance(
  options: MemoryMaintenanceOptions,
): Promise<MemoryMaintenanceResult> {
  const result: MemoryMaintenanceResult = { skipped: [] };
  const report = options.report ?? ((message: string) => console.log(message));
  const memory = options.config.memory;
  const memoryEnabled = memory?.enabled !== false;
  const learningEnabled = memory?.learningEnabled !== false;

  if (!memoryEnabled) {
    result.skipped.push("memory_disabled");
    return result;
  }
  if (!learningEnabled) {
    result.skipped.push("memory_learning_paused");
    return result;
  }

  if (memory?.bootstrapEnabled === false) {
    result.skipped.push("bootstrap_disabled");
  } else if (!looksLikeProject(options.workingDir)) {
    result.skipped.push("not_a_project");
  } else {
    try {
      result.bootstrap = await bootstrapProjectMemory({
        workingDir: options.workingDir,
        ...(options.rootDir ? { rootDir: options.rootDir } : {}),
        enabled: memoryEnabled,
        learningEnabled,
      });
      const summary = formatBootstrap(result.bootstrap);
      if (summary) report(summary);
    } catch (error) {
      result.skipped.push(`bootstrap_failed: ${errorText(error)}`);
    }
  }

  if (options.signal?.aborted) {
    result.skipped.push("cancelled");
    return result;
  }

  if (memory?.dreamAutoRun === false) {
    result.skipped.push("dream_auto_run_disabled");
    return result;
  }

  // Probing first keeps a warm start free of provider construction and, more
  // importantly, of surprise model spend when there is nothing to dream about.
  const pending = pendingDreamSummary(options.workingDir, options.rootDir);
  if (pending.queued === 0) {
    result.skipped.push("dream_queue_empty");
    return result;
  }

  try {
    result.dreams = await runQueuedDreams({
      workingDir: options.workingDir,
      model: createProvider(options.config.model),
      modelName: options.config.model.model,
      ...(options.rootDir ? { rootDir: options.rootDir } : {}),
      enabled: memoryEnabled,
      learningEnabled,
      maxRuns: memory?.dreamMaxRunsPerStart ?? 2,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const summary = formatDreams(result.dreams);
    if (summary) report(summary);
  } catch (error) {
    result.skipped.push(`dream_failed: ${errorText(error)}`);
  }
  return result;
}

function formatBootstrap(result: BootstrapProjectMemoryResult): string | null {
  const changed = result.created.length + result.revised.length +
    result.retired.length;
  if (changed === 0) return null;
  return `  🧱 项目事实已更新：新增 ${result.created.length}，` +
    `更新 ${result.revised.length}，退役 ${result.retired.length}` +
    `（release ${result.releaseId ?? "未发布"}）。用 /memory list 查看。`;
}

function formatDreams(result: DreamRunnerResult): string | null {
  if (result.attempted === 0) return null;
  const parts = [`  🌙 Dream 已处理 ${result.attempted} 个`];
  if (result.publishedReleaseIds.length > 0) {
    parts.push(`发布 ${result.publishedReleaseIds.length} 个 release`);
  }
  if (result.needsReview > 0) parts.push(`${result.needsReview} 项待复核`);
  if (result.rejected > 0) parts.push(`${result.rejected} 项被拒绝`);
  return `${parts.join("；")}。用 /profile why <key> 查看依据。`;
}

function anySignal(signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort();
      break;
    }
    signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  return controller.signal;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
