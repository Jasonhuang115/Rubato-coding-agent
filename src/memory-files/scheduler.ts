import fs from "fs";
import path from "path";
import {
  listDreamRuns,
  queueDream,
  shouldQueueDream,
  type DreamRun,
  type DreamTriggerPolicy,
} from "./dream.js";
import { loadMemoryPolicy } from "./policy.js";
import { FileMemoryRepository } from "./repository.js";
import {
  verifySession,
} from "../runtime/session/storage.js";

export interface ScheduleDreamOptions {
  workingDir: string;
  rootDir?: string;
  enabled?: boolean;
  policy?: DreamTriggerPolicy & {
    max_retries?: number;
  };
  now?: Date;
}

export interface DreamScheduleResult {
  queued: DreamRun[];
  skipped: string[];
  metrics: Array<{
    scope: "global" | "project";
    newly_closed_sessions: number;
    pending_candidates: number;
    oldest_observation_age_hours: number;
    has_new_observations: boolean;
  }>;
}

interface ClosedSession {
  id: string;
  projectId?: string;
  filePath: string;
}

/**
 * Persisted scheduling is derived from durable queue inputs: a closed session,
 * observation, or candidate already referenced by a non-rejected Dream is not
 * counted again. No in-memory timer is required, so restarts cannot reset the
 * 5-session / 20-candidate / 24-hour clocks.
 */
export function scheduleDreams(
  options: ScheduleDreamOptions,
): DreamScheduleResult {
  const result: DreamScheduleResult = {
    queued: [],
    skipped: [],
    metrics: [],
  };
  if (options.enabled === false) {
    result.skipped.push("memory_disabled");
    return result;
  }
  const persistedPolicy = loadMemoryPolicy();
  if (!persistedPolicy.learning_enabled) {
    result.skipped.push("memory_learning_paused");
    return result;
  }
  const configured = options.policy ?? (() => {
    const policy = persistedPolicy;
    return {
      closed_sessions: policy.dream.closed_sessions,
      pending_candidates: policy.dream.pending_candidates,
      observation_age_hours: policy.dream.observation_age_hours,
      max_retries: policy.dream.max_retries,
    };
  })();
  const repository = new FileMemoryRepository({
    rootDir: options.rootDir,
    projectDir: options.workingDir,
  });
  const allSessions = listVerifiedClosedRootSessions(
    repository.projectPaths.rootDir,
  );
  const now = options.now ?? new Date();

  scheduleScope({
    scope: "project",
    repository,
    sessions: allSessions.filter((session) =>
      session.projectId === repository.projectId),
    policy: configured,
    now,
    result,
  });
  scheduleScope({
    scope: "global",
    repository,
    sessions: allSessions,
    policy: configured,
    now,
    result,
  });
  return result;
}

export function listVerifiedClosedRootSessions(
  rootDir: string,
): ClosedSession[] {
  const canonicalRoot = path.resolve(rootDir);
  const sessions: ClosedSession[] = [];
  const projectsDir = path.join(canonicalRoot, "projects");
  if (fs.existsSync(projectsDir)) {
    for (const project of fs.readdirSync(projectsDir, { withFileTypes: true })) {
      if (!project.isDirectory() || !safeId(project.name)) continue;
      const sessionsDir = path.join(projectsDir, project.name, "sessions");
      sessions.push(
        ...verifiedSessionsInDir(sessionsDir, project.name),
      );
    }
  }
  // Root CLI sessions created without a SessionManager live here. Managed
  // subagents do not persist conversation records to this directory.
  sessions.push(
    ...verifiedSessionsInDir(path.join(canonicalRoot, "sessions")),
  );
  const unique = new Map<string, ClosedSession>();
  for (const session of sessions) {
    const existing = unique.get(session.id);
    if (!existing) unique.set(session.id, session);
    else if (existing.filePath !== session.filePath) {
      // UUID collisions across project stores are not safe Dream inputs.
      unique.delete(session.id);
    }
  }
  return [...unique.values()].sort((left, right) =>
    left.id.localeCompare(right.id));
}

function scheduleScope(input: {
  scope: "global" | "project";
  repository: FileMemoryRepository;
  sessions: ClosedSession[];
  policy: DreamTriggerPolicy & { max_retries?: number };
  now: Date;
  result: DreamScheduleResult;
}): void {
  const dreamsDir = input.repository.dreamsDir(input.scope);
  const existingRuns = listDreamRuns(dreamsDir)
    .filter((run) => run.status !== "rejected");
  const consumedSessions = new Set(
    existingRuns.flatMap((run) => run.session_ids ?? []),
  );
  const consumedObservations = new Set(
    existingRuns.flatMap((run) => run.observation_ids),
  );
  const consumedCandidates = new Set(
    existingRuns.flatMap((run) => run.candidate_ids),
  );
  const unseenSessions = input.sessions
    .filter((session) => !consumedSessions.has(session.id));
  const observations = input.repository
    .listObservations(input.scope)
    .filter((observation) => !consumedObservations.has(observation.id));
  const candidates = [
    ...input.repository.listCandidates("pending", input.scope),
    ...input.repository.listCandidates("review", input.scope),
  ].filter((candidate) => !consumedCandidates.has(candidate.id));
  const oldestObservation = observations
    .map((observation) => Date.parse(observation.observedAt))
    .filter(Number.isFinite)
    .sort((left, right) => left - right)[0];
  const oldestAgeHours = oldestObservation === undefined
    ? 0
    : Math.max(0, input.now.getTime() - oldestObservation) / 3_600_000;
  const metrics = {
    scope: input.scope,
    newly_closed_sessions: unseenSessions.length,
    pending_candidates: candidates.length,
    oldest_observation_age_hours: oldestAgeHours,
    has_new_observations: observations.length > 0,
  };
  input.result.metrics.push(metrics);
  const decision = shouldQueueDream(metrics, input.policy);
  if (!decision.queue) {
    input.result.skipped.push(`${input.scope}:below_threshold`);
    return;
  }

  const run = queueDream(dreamsDir, {
    scope: input.scope,
    ...(input.scope === "project"
      ? { project_id: input.repository.projectId }
      : {}),
    reason: `scheduled:${decision.reasons.join(",")}`,
    session_ids: unseenSessions.map((session) => session.id),
    observation_ids: observations.map((observation) => observation.id),
    candidate_ids: candidates.map((candidate) => candidate.id),
    max_retries: input.policy.max_retries,
  });
  input.result.queued.push(run);
}

function verifiedSessionsInDir(
  sessionsDir: string,
  projectId?: string,
): ClosedSession[] {
  if (!fs.existsSync(sessionsDir)) return [];
  const sessions: ClosedSession[] = [];
  for (const entry of fs.readdirSync(sessionsDir, { withFileTypes: true })) {
    if (
      !entry.isFile() ||
      !entry.name.endsWith(".jsonl") ||
      !safeId(entry.name.slice(0, -".jsonl".length))
    ) {
      continue;
    }
    const id = entry.name.slice(0, -".jsonl".length);
    const verification = verifySession(id, sessionsDir);
    if (!verification.valid || !verification.closed) continue;
    sessions.push({
      id,
      ...(projectId ? { projectId } : {}),
      filePath: path.join(sessionsDir, entry.name),
    });
  }
  return sessions;
}

function safeId(value: string): boolean {
  return /^[a-zA-Z0-9._-]{1,200}$/u.test(value);
}
