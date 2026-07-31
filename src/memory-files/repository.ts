import { createHash, randomUUID } from "crypto";
import fs from "fs";
import path from "path";
import type { UserObservation, UserMemoryScope } from "./observation.js";
import { isAdmissibleUserEvidence } from "./observation.js";
import type { UserBelief, UserModelOperation } from "./user-model.js";
import {
  projectMemoryId,
  resolveMemoryScopePaths,
} from "./paths.js";
import type { MemoryScopePaths } from "./types.js";
import { findMemorySafetyIssues } from "./policy.js";

export type CandidateState = "pending" | "review" | "rejected" | "published";
export type CandidateRisk = "low" | "medium" | "high";

export interface MemoryCandidate {
  schema: "rubato.memory.candidate/v1";
  id: string;
  input_digest: string;
  state: CandidateState;
  operation: UserModelOperation["kind"];
  scope: UserMemoryScope;
  project_id?: string;
  logical_key: string;
  risk: CandidateRisk;
  requires_review: boolean;
  reason: string;
  evidence_ids: string[];
  target_ids: string[];
  status_patches: UserModelOperation["statusPatches"];
  proposed_belief?: UserBelief;
  created_at: string;
  updated_at: string;
  review_reason?: string;
}

export interface PersistObservationResult {
  written: boolean;
  filePath: string;
  reason?: "duplicate";
}

export interface RepositoryOptions {
  rootDir?: string;
  projectDir: string;
}

export class FileMemoryRepository {
  readonly projectId: string;
  readonly globalPaths: MemoryScopePaths;
  readonly projectPaths: MemoryScopePaths;

  constructor(options: RepositoryOptions) {
    this.projectId = projectMemoryId(options.projectDir);
    this.globalPaths = resolveMemoryScopePaths({
      rootDir: options.rootDir,
      scope: "global",
    });
    this.projectPaths = resolveMemoryScopePaths({
      rootDir: options.rootDir,
      scope: "project",
      projectId: this.projectId,
    });
  }

  pathsForScope(scope: UserMemoryScope): MemoryScopePaths {
    if (scope.kind === "project") {
      if (scope.value !== this.projectId) {
        throw new Error(
          `Observation project scope ${scope.value ?? "(missing)"} ` +
          `does not match current project ${this.projectId}`,
        );
      }
      return this.projectPaths;
    }
    return this.globalPaths;
  }

  appendObservation(observation: UserObservation): PersistObservationResult {
    validatePersistableObservation(observation);
    const paths = this.pathsForScope(observation.scope);
    const observedAt = new Date(observation.observedAt);
    const year = String(observedAt.getUTCFullYear());
    const month = String(observedAt.getUTCMonth() + 1).padStart(2, "0");
    const day = String(observedAt.getUTCDate()).padStart(2, "0");
    const filePath = path.join(
      paths.scopeDir,
      "observations",
      year,
      month,
      `${year}-${month}-${day}.jsonl`,
    );
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    return withFileLock(`${paths.scopeDir}/.observation.lock`, () => {
      if (observationExists(filePath, observation.id)) {
        return { written: false, filePath, reason: "duplicate" as const };
      }
      fs.appendFileSync(filePath, `${JSON.stringify(observation)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      return { written: true, filePath };
    });
  }

  listObservations(scope?: "global" | "project"): UserObservation[] {
    const paths = scope === "global"
      ? [this.globalPaths]
      : scope === "project"
        ? [this.projectPaths]
        : [this.globalPaths, this.projectPaths];
    return paths.flatMap((item) => readObservationTree(item.scopeDir))
      .sort((a, b) =>
        a.observedAt.localeCompare(b.observedAt) || a.id.localeCompare(b.id));
  }

  writeCandidate(
    operation: UserModelOperation,
    risk: CandidateRisk,
    state: CandidateState = operation.requiresReview ? "review" : "pending",
  ): MemoryCandidate {
    const paths = this.pathsForScope(operation.scope);
    const unsafe = findMemorySafetyIssues(JSON.stringify(operation));
    if (unsafe.length > 0) {
      throw new Error(
        `Candidate contains prohibited content: ${unsafe.join(", ")}`,
      );
    }
    const digest = operationDigest(operation);
    const existing = this.findCandidateByDigest(paths, digest);
    if (existing) return existing;

    const now = new Date().toISOString();
    const candidate: MemoryCandidate = {
      schema: "rubato.memory.candidate/v1",
      id: `candidate_${digest.slice(0, 24)}`,
      input_digest: digest,
      state,
      operation: operation.kind,
      scope: operation.scope,
      ...(paths.projectId ? { project_id: paths.projectId } : {}),
      logical_key: operation.logicalKey,
      risk,
      requires_review: operation.requiresReview,
      reason: operation.reason.slice(0, 1_000),
      evidence_ids: [...new Set(operation.evidenceIds)].sort(),
      target_ids: [...new Set(operation.targetIds)].sort(),
      status_patches: operation.statusPatches,
      proposed_belief: operation.proposedBelief,
      created_at: now,
      updated_at: now,
    };
    writeCandidateFile(paths, candidate);
    return candidate;
  }

  listCandidates(
    state?: CandidateState,
    scope?: "global" | "project",
  ): MemoryCandidate[] {
    const paths = scope === "global"
      ? [this.globalPaths]
      : scope === "project"
        ? [this.projectPaths]
        : [this.globalPaths, this.projectPaths];
    const states: CandidateState[] = state
      ? [state]
      : ["pending", "review", "rejected", "published"];
    const candidates = paths.flatMap((item) =>
      states.flatMap((candidateState) =>
        readCandidateDir(candidateDir(item, candidateState))));
    return candidates.sort((a, b) =>
      a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  }

  moveCandidate(
    id: string,
    nextState: CandidateState,
    reason?: string,
  ): MemoryCandidate {
    if (!/^[a-zA-Z0-9._-]+$/.test(id)) {
      throw new Error("Unsafe candidate ID");
    }
    for (const paths of [this.globalPaths, this.projectPaths]) {
      for (const state of ["pending", "review", "rejected", "published"] as const) {
        const source = path.join(candidateDir(paths, state), `${id}.json`);
        if (!fs.existsSync(source)) continue;
        const candidate = parseCandidate(source);
        const updated: MemoryCandidate = {
          ...candidate,
          state: nextState,
          updated_at: new Date().toISOString(),
          ...(reason ? { review_reason: reason.slice(0, 1_000) } : {}),
        };
        const target = candidatePath(paths, nextState, id);
        fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
        atomicWriteJson(target, updated);
        if (source !== target) fs.unlinkSync(source);
        return updated;
      }
    }
    throw new Error(`Candidate not found: ${id}`);
  }

  dreamsDir(scope: "global" | "project"): string {
    const paths = scope === "global" ? this.globalPaths : this.projectPaths;
    return path.join(paths.scopeDir, "dreams");
  }

  private findCandidateByDigest(
    paths: MemoryScopePaths,
    digest: string,
  ): MemoryCandidate | null {
    for (const state of ["pending", "review", "rejected", "published"] as const) {
      for (const candidate of readCandidateDir(candidateDir(paths, state))) {
        if (candidate.input_digest === digest) return candidate;
      }
    }
    return null;
  }
}

export function operationDigest(operation: UserModelOperation): string {
  return createHash("sha256")
    .update(stableJson(operation))
    .digest("hex");
}

function validatePersistableObservation(observation: UserObservation): void {
  if (!isAdmissibleUserEvidence(observation)) {
    throw new Error("Only user-authored observations may be persisted");
  }
  if (!Number.isInteger(observation.eventSeq) || (observation.eventSeq ?? -1) < 0) {
    throw new Error("Observation requires a source event sequence");
  }
  if (!observation.eventHash || !/^[a-f0-9]{64}$/.test(observation.eventHash)) {
    throw new Error("Observation requires a valid source event hash");
  }
  if (findMemorySafetyIssues(observation.value).length > 0) {
    throw new Error("Observation contains prohibited secret or instruction content");
  }
}

function readObservationTree(scopeDir: string): UserObservation[] {
  const root = path.join(scopeDir, "observations");
  if (!fs.existsSync(root)) return [];
  const observations: UserObservation[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const filePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(filePath);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        for (const line of fs.readFileSync(filePath, "utf8").split("\n")) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line) as UserObservation;
            if (isAdmissibleUserEvidence(parsed)) observations.push(parsed);
          } catch {
            // A partial append does not invalidate earlier observations.
          }
        }
      }
    }
  };
  walk(root);
  return observations;
}

function observationExists(filePath: string, id: string): boolean {
  if (!fs.existsSync(filePath)) return false;
  return fs.readFileSync(filePath, "utf8").split("\n").some((line) => {
    if (!line.includes(id)) return false;
    try {
      return (JSON.parse(line) as { id?: unknown }).id === id;
    } catch {
      return false;
    }
  });
}

function candidateDir(
  paths: MemoryScopePaths,
  state: CandidateState,
): string {
  return path.join(paths.scopeDir, "candidates", state);
}

function candidatePath(
  paths: MemoryScopePaths,
  state: CandidateState,
  id: string,
): string {
  return path.join(candidateDir(paths, state), `${id}.json`);
}

function writeCandidateFile(
  paths: MemoryScopePaths,
  candidate: MemoryCandidate,
): void {
  atomicWriteJson(
    candidatePath(paths, candidate.state, candidate.id),
    candidate,
  );
}

function readCandidateDir(dir: string): MemoryCandidate[] {
  if (!fs.existsSync(dir)) return [];
  const candidates: MemoryCandidate[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    try {
      candidates.push(parseCandidate(path.join(dir, entry.name)));
    } catch {
      // Corrupt/untrusted candidates never reach the reducer.
    }
  }
  return candidates;
}

function parseCandidate(filePath: string): MemoryCandidate {
  const candidate = JSON.parse(fs.readFileSync(filePath, "utf8")) as MemoryCandidate;
  if (
    candidate.schema !== "rubato.memory.candidate/v1" ||
    !candidate.id ||
    !/^[a-f0-9]{64}$/.test(candidate.input_digest) ||
    !["pending", "review", "rejected", "published"].includes(candidate.state)
  ) {
    throw new Error(`Invalid candidate: ${filePath}`);
  }
  return candidate;
}

function atomicWriteJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.tmp.${randomUUID()}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.renameSync(temporary, filePath);
}

function withFileLock<T>(lockPath: string, action: () => T): T {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  let descriptor: number | undefined;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      descriptor = fs.openSync(lockPath, "wx", 0o600);
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      const start = Date.now();
      while (Date.now() - start < 5) {
        // Tiny bounded contention wait; no asynchronous caller is blocked long.
      }
    }
  }
  if (descriptor === undefined) throw new Error("Memory observation lock is busy");
  try {
    return action();
  } finally {
    fs.closeSync(descriptor);
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // The lock has served its purpose; a stale lock is recoverable by review.
    }
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) =>
      `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
