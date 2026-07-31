// Dream runner — the piece that actually makes memory self-evolving.
//
// scheduleDreams() writes durable queue records; this module drains them. It is
// deliberately a separate, bounded driver rather than something the agent loop
// awaits: Dreaming costs model calls, so it runs with an explicit run cap, a
// wall-clock budget, and a cancellation signal, and it never blocks a user turn.
//
// All authority still lives downstream. runNextDream() disables publishing for
// the model, so the worst a bad Dream can do is leave review candidates behind.

import os from "os";
import { listDreamRuns, recoverExpiredDreams } from "./dream.js";
import { runNextDream, type DreamWorkerResult } from "./dream-worker.js";
import { loadMemoryPolicy } from "./policy.js";
import { FileMemoryRepository } from "./repository.js";
import type { ModelProvider } from "../shared/core-types.js";

export interface DreamRunnerOptions {
  workingDir: string;
  model: ModelProvider;
  modelName: string;
  rootDir?: string;
  /** Master memory switch. */
  enabled?: boolean;
  /** Paused learning stops Dreaming even when runs are already queued. */
  learningEnabled?: boolean;
  /** Hard cap on Dreams processed per invocation. */
  maxRuns?: number;
  /** Wall-clock budget; a new Dream is not started once it is exhausted. */
  budgetMs?: number;
  maxTokens?: number;
  owner?: string;
  signal?: AbortSignal;
  now?: Date;
}

export interface DreamRunnerResult {
  attempted: number;
  publishedReleaseIds: string[];
  needsReview: number;
  rejected: number;
  reviewCandidateIds: string[];
  skipped: string[];
  errors: string[];
}

export interface PendingDreamSummary {
  queued: number;
  byScope: { global: number; project: number };
}

const DEFAULT_MAX_RUNS = 2;
const DEFAULT_BUDGET_MS = 120_000;
const SCOPES = ["project", "global"] as const;

/**
 * Cheap, model-free queue probe. Callers use this to decide whether starting a
 * runner (and constructing a provider) is worth it at all.
 */
export function pendingDreamSummary(
  workingDir: string,
  rootDir?: string,
): PendingDreamSummary {
  const summary: PendingDreamSummary = {
    queued: 0,
    byScope: { global: 0, project: 0 },
  };
  try {
    const repository = new FileMemoryRepository({ rootDir, projectDir: workingDir });
    for (const scope of SCOPES) {
      const dreamsDir = repository.dreamsDir(scope);
      // Reviving expired leases here keeps a crashed run from parking work
      // forever without needing a separate janitor.
      recoverExpiredDreams(dreamsDir);
      const queued = listDreamRuns(dreamsDir)
        .filter((run) => run.status === "queued").length;
      summary.byScope[scope] = queued;
      summary.queued += queued;
    }
  } catch {
    // An unreadable queue is reported as empty; nothing is published blindly.
  }
  return summary;
}

export async function runQueuedDreams(
  options: DreamRunnerOptions,
): Promise<DreamRunnerResult> {
  const result: DreamRunnerResult = {
    attempted: 0,
    publishedReleaseIds: [],
    needsReview: 0,
    rejected: 0,
    reviewCandidateIds: [],
    skipped: [],
    errors: [],
  };
  if (options.enabled === false) {
    result.skipped.push("memory_disabled");
    return result;
  }
  const policy = loadMemoryPolicy(options.rootDir);
  if (options.learningEnabled === false || !policy.learning_enabled) {
    result.skipped.push("memory_learning_paused");
    return result;
  }

  const maxRuns = Math.max(1, Math.round(options.maxRuns ?? DEFAULT_MAX_RUNS));
  const budgetMs = Math.max(1_000, Math.round(options.budgetMs ?? DEFAULT_BUDGET_MS));
  const owner = options.owner ?? `cli:${os.hostname()}:${process.pid}`;
  const startedAt = Date.now();

  for (const scope of SCOPES) {
    while (result.attempted < maxRuns) {
      if (options.signal?.aborted) {
        result.skipped.push("cancelled");
        return result;
      }
      if (Date.now() - startedAt >= budgetMs) {
        result.skipped.push("budget_exhausted");
        return result;
      }

      let outcome: DreamWorkerResult | null;
      try {
        outcome = await runNextDream({
          workingDir: options.workingDir,
          scope,
          model: options.model,
          modelName: options.modelName,
          owner,
          leaseMinutes: policy.dream.lease_minutes,
          ...(options.rootDir ? { rootDir: options.rootDir } : {}),
          ...(options.maxTokens ? { maxTokens: options.maxTokens } : {}),
          ...(options.now ? { now: options.now } : {}),
        });
      } catch (error) {
        // The run record already carries its own failure state; the driver only
        // needs to stop working on this scope.
        result.errors.push(
          `${scope}: ${error instanceof Error ? error.message : String(error)}`,
        );
        break;
      }

      if (!outcome) break; // Nothing queued for this scope.
      result.attempted++;
      collectOutcome(result, outcome);
    }
  }

  return result;
}

function collectOutcome(
  result: DreamRunnerResult,
  outcome: DreamWorkerResult,
): void {
  if (outcome.error) result.errors.push(outcome.error);
  if (outcome.run.status === "needs_review") result.needsReview++;
  if (outcome.run.status === "rejected") result.rejected++;

  const publication = outcome.publication;
  if (publication) {
    result.publishedReleaseIds.push(...publication.publishedReleaseIds);
    result.reviewCandidateIds.push(...publication.reviewCandidateIds);
    result.needsReview += publication.reviewCandidateIds.length;
    result.rejected += publication.rejectedCandidateIds.length;
  }
  if (outcome.learning) {
    result.needsReview += outcome.learning.needsReview;
  }
}
