import { createHash, randomUUID } from "crypto";
import fs from "fs";
import path from "path";

export type DreamRunStatus =
  | "queued"
  | "leased"
  | "running"
  | "produced"
  | "validated"
  | "published"
  | "needs_review"
  | "rejected";

export interface DreamRun {
  schema: "rubato.memory.dream/v1";
  run_id: string;
  input_digest: string;
  status: DreamRunStatus;
  scope: "global" | "project";
  project_id?: string;
  reason: string;
  /** Closed, hash-verified root sessions available to the Dream worker. */
  session_ids: string[];
  observation_ids: string[];
  candidate_ids: string[];
  attempts: number;
  max_retries: number;
  created_at: string;
  updated_at: string;
  lease_owner?: string;
  lease_expires_at?: string;
  operation_count?: number;
  release_id?: string;
  review_reason?: string;
  error?: string;
}

export interface DreamQueueInput {
  scope: "global" | "project";
  project_id?: string;
  reason: string;
  session_ids?: string[];
  observation_ids: string[];
  candidate_ids: string[];
  max_retries?: number;
}

export interface DreamTriggerMetrics {
  newly_closed_sessions: number;
  pending_candidates: number;
  oldest_observation_age_hours: number;
  has_new_observations: boolean;
}

export interface DreamTriggerPolicy {
  closed_sessions: number;
  pending_candidates: number;
  observation_age_hours: number;
}

const TERMINAL: ReadonlySet<DreamRunStatus> = new Set([
  "published",
  "needs_review",
  "rejected",
]);

const TRANSITIONS: Readonly<Record<DreamRunStatus, DreamRunStatus[]>> = {
  queued: ["leased", "rejected"],
  leased: ["running", "queued", "needs_review", "rejected"],
  running: ["produced", "queued", "needs_review", "rejected"],
  produced: ["validated", "needs_review", "rejected"],
  validated: ["published", "needs_review", "rejected"],
  published: [],
  needs_review: [],
  rejected: [],
};

export function shouldQueueDream(
  metrics: DreamTriggerMetrics,
  policy: DreamTriggerPolicy,
): { queue: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (metrics.newly_closed_sessions >= policy.closed_sessions) {
    reasons.push("closed_session_threshold");
  }
  if (metrics.pending_candidates >= policy.pending_candidates) {
    reasons.push("candidate_threshold");
  }
  if (
    metrics.has_new_observations &&
    metrics.oldest_observation_age_hours >= policy.observation_age_hours
  ) {
    reasons.push("observation_age_threshold");
  }
  return { queue: reasons.length > 0, reasons };
}

export function dreamInputDigest(input: DreamQueueInput): string {
  const stable = {
    scope: input.scope,
    project_id: input.project_id ?? "",
    session_ids: [...new Set(input.session_ids ?? [])].sort(),
    observation_ids: [...new Set(input.observation_ids)].sort(),
    candidate_ids: [...new Set(input.candidate_ids)].sort(),
  };
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

export function queueDream(
  dreamsDir: string,
  input: DreamQueueInput,
): DreamRun {
  fs.mkdirSync(dreamsDir, { recursive: true, mode: 0o700 });
  const digest = dreamInputDigest(input);
  const existing = listDreamRuns(dreamsDir).find((run) =>
    run.input_digest === digest && run.status !== "rejected",
  );
  if (existing) return existing;

  const now = new Date().toISOString();
  const run: DreamRun = {
    schema: "rubato.memory.dream/v1",
    run_id: `dream_${Date.now()}_${randomUUID().slice(0, 8)}`,
    input_digest: digest,
    status: "queued",
    scope: input.scope,
    ...(input.project_id ? { project_id: input.project_id } : {}),
    reason: input.reason.slice(0, 500),
    session_ids: [...new Set(input.session_ids ?? [])].sort(),
    observation_ids: [...new Set(input.observation_ids)].sort(),
    candidate_ids: [...new Set(input.candidate_ids)].sort(),
    attempts: 0,
    max_retries: Math.max(0, Math.round(input.max_retries ?? 3)),
    created_at: now,
    updated_at: now,
  };
  writeDreamRun(dreamsDir, run);
  return run;
}

export function listDreamRuns(dreamsDir: string): DreamRun[] {
  if (!fs.existsSync(dreamsDir)) return [];
  const runs: DreamRun[] = [];
  for (const entry of fs.readdirSync(dreamsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const run = readDreamRun(dreamsDir, entry.name);
    if (run) runs.push(run);
  }
  return runs.sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export function readDreamRun(
  dreamsDir: string,
  runId: string,
): DreamRun | null {
  if (!safeRunId(runId)) return null;
  const filePath = path.join(dreamsDir, runId, "run.json");
  if (!fs.existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as DreamRun;
    // Runs queued before session-aware Dreaming remain recoverable.
    if (!Array.isArray(parsed.session_ids)) parsed.session_ids = [];
    validateDreamRun(parsed);
    return parsed;
  } catch {
    return null;
  }
}

export function leaseNextDream(
  dreamsDir: string,
  owner: string,
  leaseMinutes = 15,
  now = new Date(),
): DreamRun | null {
  recoverExpiredDreams(dreamsDir, now);
  const queued = listDreamRuns(dreamsDir).find((run) => run.status === "queued");
  if (!queued) return null;
  return updateDreamRun(dreamsDir, queued.run_id, "leased", {
    attempts: queued.attempts + 1,
    lease_owner: owner.slice(0, 200),
    lease_expires_at: new Date(
      now.getTime() + Math.max(1, leaseMinutes) * 60_000,
    ).toISOString(),
    error: undefined,
  });
}

export function markDreamRunning(
  dreamsDir: string,
  runId: string,
  owner: string,
): DreamRun {
  const current = requiredDream(dreamsDir, runId);
  if (current.lease_owner !== owner) {
    throw new Error(`Dream ${runId} is leased by another worker`);
  }
  return updateDreamRun(dreamsDir, runId, "running");
}

export function markDreamProduced(
  dreamsDir: string,
  runId: string,
  operations: unknown[],
): DreamRun {
  const runDir = dreamRunDir(dreamsDir, runId);
  atomicWrite(
    path.join(runDir, "operations.json"),
    `${JSON.stringify(operations, null, 2)}\n`,
  );
  return updateDreamRun(dreamsDir, runId, "produced", {
    operation_count: operations.length,
    lease_owner: undefined,
    lease_expires_at: undefined,
  });
}

export function markDreamValidated(
  dreamsDir: string,
  runId: string,
): DreamRun {
  return updateDreamRun(dreamsDir, runId, "validated");
}

export function markDreamPublished(
  dreamsDir: string,
  runId: string,
  releaseId: string,
): DreamRun {
  return updateDreamRun(dreamsDir, runId, "published", {
    release_id: releaseId,
  });
}

export function markDreamNeedsReview(
  dreamsDir: string,
  runId: string,
  reason: string,
): DreamRun {
  const current = requiredDream(dreamsDir, runId);
  if (
    current.status === "leased" ||
    current.status === "running" ||
    current.status === "produced" ||
    current.status === "validated"
  ) {
    return updateDreamRun(dreamsDir, runId, "needs_review", {
      review_reason: reason.slice(0, 1_000),
      lease_owner: undefined,
      lease_expires_at: undefined,
    });
  }
  throw new Error(`Cannot send Dream ${runId} to review from ${current.status}`);
}

export function rejectDream(
  dreamsDir: string,
  runId: string,
  reason: string,
): DreamRun {
  return updateDreamRun(dreamsDir, runId, "rejected", {
    review_reason: reason.slice(0, 1_000),
    lease_owner: undefined,
    lease_expires_at: undefined,
  });
}

export function failDream(
  dreamsDir: string,
  runId: string,
  error: string,
): DreamRun {
  const current = requiredDream(dreamsDir, runId);
  if (current.status !== "leased" && current.status !== "running") {
    throw new Error(`Cannot fail Dream ${runId} from ${current.status}`);
  }
  if (current.attempts > current.max_retries) {
    return updateDreamRun(dreamsDir, runId, "needs_review", {
      error: error.slice(0, 1_000),
      review_reason: "retry_limit_exceeded",
      lease_owner: undefined,
      lease_expires_at: undefined,
    });
  }
  return updateDreamRun(dreamsDir, runId, "queued", {
    error: error.slice(0, 1_000),
    lease_owner: undefined,
    lease_expires_at: undefined,
  });
}

export function recoverExpiredDreams(
  dreamsDir: string,
  now = new Date(),
): DreamRun[] {
  const recovered: DreamRun[] = [];
  for (const run of listDreamRuns(dreamsDir)) {
    if (
      (run.status !== "leased" && run.status !== "running") ||
      !run.lease_expires_at ||
      Date.parse(run.lease_expires_at) > now.getTime()
    ) {
      continue;
    }
    recovered.push(failDream(dreamsDir, run.run_id, "lease_expired"));
  }
  return recovered;
}

export function isTerminalDream(run: DreamRun): boolean {
  return TERMINAL.has(run.status);
}

function updateDreamRun(
  dreamsDir: string,
  runId: string,
  nextStatus: DreamRunStatus,
  patch: Partial<DreamRun> = {},
): DreamRun {
  const current = requiredDream(dreamsDir, runId);
  if (!TRANSITIONS[current.status].includes(nextStatus)) {
    throw new Error(
      `Invalid Dream transition ${current.status} -> ${nextStatus}`,
    );
  }
  const next: DreamRun = {
    ...current,
    ...patch,
    schema: "rubato.memory.dream/v1",
    run_id: current.run_id,
    input_digest: current.input_digest,
    status: nextStatus,
    updated_at: new Date().toISOString(),
  };
  writeDreamRun(dreamsDir, next);
  return next;
}

function requiredDream(dreamsDir: string, runId: string): DreamRun {
  const run = readDreamRun(dreamsDir, runId);
  if (!run) throw new Error(`Dream ${runId} does not exist or is invalid`);
  return run;
}

function writeDreamRun(dreamsDir: string, run: DreamRun): void {
  validateDreamRun(run);
  const runDir = dreamRunDir(dreamsDir, run.run_id);
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
  atomicWrite(path.join(runDir, "run.json"), `${JSON.stringify(run, null, 2)}\n`);
}

function dreamRunDir(dreamsDir: string, runId: string): string {
  if (!safeRunId(runId)) throw new Error(`Unsafe Dream run ID: ${runId}`);
  return path.join(dreamsDir, runId);
}

function safeRunId(value: string): boolean {
  return /^dream_[A-Za-z0-9_-]+$/.test(value);
}

function validateDreamRun(run: DreamRun): void {
  if (run.schema !== "rubato.memory.dream/v1") {
    throw new Error("Unsupported Dream schema");
  }
  if (!safeRunId(run.run_id)) throw new Error("Invalid Dream run ID");
  if (!/^[a-f0-9]{64}$/.test(run.input_digest)) {
    throw new Error("Invalid Dream input digest");
  }
  if (!(run.status in TRANSITIONS)) throw new Error("Invalid Dream status");
  if (run.scope === "project" && !run.project_id) {
    throw new Error("Project Dream requires project_id");
  }
  if (
    !Array.isArray(run.session_ids) ||
    run.session_ids.some((id) =>
      typeof id !== "string" || !/^[a-zA-Z0-9._-]{1,200}$/.test(id))
  ) {
    throw new Error("Dream contains invalid session IDs");
  }
}

function atomicWrite(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.tmp.${randomUUID()}`;
  fs.writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, filePath);
}
