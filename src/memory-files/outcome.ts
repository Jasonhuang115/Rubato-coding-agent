import { createHash, randomUUID } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

export interface OutcomeVector {
  task_utility: number;
  personalization: number;
  efficiency: number;
  retention: number;
  safety: number;
}

export interface MemoryOutcomeInput {
  session_id: string;
  task_tags: string[];
  memory_searched?: string[];
  memory_read?: string[];
  memory_applied?: string[];
  skills_used?: string[];
  tests_passed?: boolean;
  build_passed?: boolean;
  user_signal?: "accepted" | "corrected" | "withdrawn" | "unknown";
  tool_steps?: number;
  tokens?: number;
  latency_ms?: number;
  release_ids?: string[];
  reward: OutcomeVector;
}

export interface MemoryOutcome extends MemoryOutcomeInput {
  schema: "rubato.memory.outcome/v1";
  event_id: string;
  recorded_at: string;
  prev_hash: string;
  hash: string;
}

export interface UtilityEstimate {
  task_tag: string;
  memory_id: string;
  uses: number;
  q: number;
  eligible: boolean;
}

const ZERO_HASH = "0".repeat(64);

export function getRubatoHome(): string {
  return path.resolve(
    process.env.RUBATO_HOME ?? path.join(os.homedir(), ".rubato"),
  );
}

export function getOutcomePath(): string {
  return path.join(getRubatoHome(), "memory", "outcomes.jsonl");
}

/**
 * Record result evidence. The record intentionally contains IDs and aggregate
 * measurements, never prompts, tool output, or copied user text.
 */
export function recordMemoryOutcome(input: MemoryOutcomeInput): MemoryOutcome {
  validateOutcomeInput(input);
  const filePath = getOutcomePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const previous = readLastOutcome(filePath);
  const withoutHash = {
    schema: "rubato.memory.outcome/v1" as const,
    event_id: `out_${randomUUID()}`,
    recorded_at: new Date().toISOString(),
    session_id: input.session_id,
    task_tags: uniqueSafeStrings(input.task_tags),
    memory_searched: uniqueSafeStrings(input.memory_searched ?? []),
    memory_read: uniqueSafeStrings(input.memory_read ?? []),
    memory_applied: uniqueSafeStrings(input.memory_applied ?? []),
    skills_used: uniqueSafeStrings(input.skills_used ?? []),
    tests_passed: input.tests_passed,
    build_passed: input.build_passed,
    user_signal: input.user_signal ?? "unknown",
    tool_steps: nonNegativeInteger(input.tool_steps),
    tokens: nonNegativeInteger(input.tokens),
    latency_ms: nonNegativeInteger(input.latency_ms),
    release_ids: uniqueSafeStrings(input.release_ids ?? []),
    reward: normalizeReward(input.reward),
    prev_hash: previous?.hash ?? ZERO_HASH,
  };
  const outcome: MemoryOutcome = {
    ...withoutHash,
    hash: sha256(stableJson(withoutHash)),
  };
  fs.appendFileSync(filePath, `${JSON.stringify(outcome)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return outcome;
}

export function listMemoryOutcomes(): MemoryOutcome[] {
  const filePath = getOutcomePath();
  if (!fs.existsSync(filePath)) return [];
  const outcomes: MemoryOutcome[] = [];
  let expectedPrev = ZERO_HASH;
  for (const line of fs.readFileSync(filePath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as MemoryOutcome;
      const { hash, ...withoutHash } = parsed;
      if (
        parsed.schema !== "rubato.memory.outcome/v1" ||
        parsed.prev_hash !== expectedPrev ||
        hash !== sha256(stableJson(withoutHash))
      ) {
        continue;
      }
      outcomes.push(parsed);
      expectedPrev = hash;
    } catch {
      // A partial final append is ignored; earlier verified records remain usable.
    }
  }
  return outcomes;
}

/**
 * Non-parametric contextual-bandit estimate. Belief confidence is deliberately
 * absent: outcome utility may reorder already-matching cards, never make a
 * user fact more believable.
 */
export function estimateMemoryUtility(
  outcomes = listMemoryOutcomes(),
  learningRate = 0.2,
  minimumUses = 5,
): UtilityEstimate[] {
  const alpha = clamp(learningRate, 0.01, 1);
  const states = new Map<string, UtilityEstimate>();
  for (const outcome of outcomes) {
    const reward = scalarReward(outcome.reward);
    for (const taskTag of outcome.task_tags) {
      for (const memoryId of outcome.memory_applied ?? []) {
        const key = `${taskTag}\u0000${memoryId}`;
        const previous = states.get(key);
        const uses = (previous?.uses ?? 0) + 1;
        const q = previous === undefined
          ? reward
          : (1 - alpha) * previous.q + alpha * reward;
        states.set(key, {
          task_tag: taskTag,
          memory_id: memoryId,
          uses,
          q,
          eligible: uses >= minimumUses,
        });
      }
    }
  }
  return [...states.values()].sort((a, b) =>
    a.task_tag.localeCompare(b.task_tag) ||
    Number(b.eligible) - Number(a.eligible) ||
    b.q - a.q ||
    a.memory_id.localeCompare(b.memory_id),
  );
}

export interface MemoryUtilityScoreOptions {
  /**
   * Restricts the estimate to these task tags. Omitted, every tag contributes,
   * which is the right default for a query with no known task context.
   */
  taskTags?: ReadonlyArray<string>;
  learningRate?: number;
  minimumUses?: number;
  outcomes?: MemoryOutcome[];
}

/**
 * Collapses per-tag estimates into one score per memory id, keeping only
 * estimates that have cleared the minimum-uses gate.
 *
 * This is the value recall is allowed to consult. It can reorder memories that
 * already matched a query; it can never add a memory, remove one, or change how
 * believable a card is.
 */
export function memoryUtilityScores(
  options: MemoryUtilityScoreOptions = {},
): Map<string, number> {
  const wanted = options.taskTags && options.taskTags.length > 0
    ? new Set(options.taskTags)
    : null;
  const scores = new Map<string, number>();
  const counts = new Map<string, number>();

  for (const estimate of estimateMemoryUtility(
    options.outcomes,
    options.learningRate,
    options.minimumUses,
  )) {
    if (!estimate.eligible) continue;
    if (wanted && !wanted.has(estimate.task_tag)) continue;
    scores.set(
      estimate.memory_id,
      (scores.get(estimate.memory_id) ?? 0) + estimate.q,
    );
    counts.set(estimate.memory_id, (counts.get(estimate.memory_id) ?? 0) + 1);
  }

  for (const [memoryId, total] of scores) {
    scores.set(memoryId, total / (counts.get(memoryId) ?? 1));
  }
  return scores;
}

export function scalarReward(reward: OutcomeVector): number {
  const normalized = normalizeReward(reward);
  // Safety has veto-like force without collapsing the auditable vector.
  if (normalized.safety < 0) {
    return clamp(normalized.safety, -1, 0);
  }
  return clamp(
    0.35 * normalized.task_utility +
    0.25 * normalized.personalization +
    0.15 * normalized.efficiency +
    0.1 * normalized.retention +
    0.15 * normalized.safety,
    -1,
    1,
  );
}

function readLastOutcome(filePath: string): MemoryOutcome | null {
  if (!fs.existsSync(filePath)) return null;
  const lines = fs.readFileSync(filePath, "utf8").trim().split("\n");
  for (let index = lines.length - 1; index >= 0; index--) {
    try {
      const parsed = JSON.parse(lines[index]) as MemoryOutcome;
      if (parsed.hash) return parsed;
    } catch {
      // Skip an incomplete append.
    }
  }
  return null;
}

function validateOutcomeInput(input: MemoryOutcomeInput): void {
  if (!input.session_id.trim()) throw new Error("session_id is required");
  if (input.task_tags.length === 0) throw new Error("at least one task tag is required");
  normalizeReward(input.reward);
}

function normalizeReward(reward: OutcomeVector): OutcomeVector {
  return {
    task_utility: finiteUnit(reward.task_utility, "task_utility"),
    personalization: finiteUnit(reward.personalization, "personalization"),
    efficiency: finiteUnit(reward.efficiency, "efficiency"),
    retention: finiteUnit(reward.retention, "retention"),
    safety: finiteUnit(reward.safety, "safety"),
  };
}

function finiteUnit(value: number, name: string): number {
  if (!Number.isFinite(value)) throw new Error(`${name} must be finite`);
  return clamp(value, -1, 1);
}

function uniqueSafeStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
    .map((value) => value.slice(0, 200))
    .sort();
}

function nonNegativeInteger(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.round(value));
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, item]) =>
      `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
