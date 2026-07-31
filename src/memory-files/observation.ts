/**
 * Atomic evidence used by the file-backed user model.
 *
 * This module deliberately treats observations as evidence, not as published
 * profile facts. In particular, an LLM may propose an observation, but only a
 * user-authored source event can contribute non-zero weight.
 */

export type ObservationActor = "user" | "assistant" | "tool" | "system";

export type UserSignal =
  | "approval"
  | "remember"
  | "correction"
  | "explicit_preference"
  | "explicit_constraint"
  | "explicit_goal"
  | "choice"
  | "habit"
  | "inference"
  | "other";

export type EvidencePolarity = "support" | "oppose";

export type UserMemoryScopeKind =
  | "global"
  | "domain"
  | "project"
  | "surface";

export interface UserMemoryScope {
  kind: UserMemoryScopeKind;
  /** Required for every non-global scope. */
  value?: string;
}

export interface UserObservation {
  id: string;
  actor: ObservationActor;
  signal: UserSignal;
  logicalKey: string;
  value: string;
  scope: UserMemoryScope;
  polarity: EvidencePolarity;
  sessionId: string;
  eventId?: string;
  /** Sequence/hash bind the derived evidence to a hash-chained session event. */
  eventSeq?: number;
  eventHash?: string;
  observedAt: string;
  /**
   * An extractor may lower a signal's default weight, but it cannot raise it.
   * This prevents an LLM-produced proposal from granting itself authority.
   */
  proposedWeight?: number;
}

/**
 * Operational pseudo-counts used by the confidence formula.
 *
 * A single explicit preference is intentionally strong enough to become
 * active. An inference remains a candidate until independent evidence appears.
 */
export const USER_SIGNAL_WEIGHTS: Readonly<Record<UserSignal, number>> = {
  approval: 12,
  remember: 12,
  correction: 12,
  explicit_preference: 8,
  explicit_constraint: 8,
  explicit_goal: 8,
  choice: 5,
  habit: 2,
  inference: 1,
  other: 0,
};

const EXPLICIT_SIGNALS: ReadonlySet<UserSignal> = new Set([
  "approval",
  "remember",
  "correction",
  "explicit_preference",
  "explicit_constraint",
  "explicit_goal",
]);

const DAY_MS = 24 * 60 * 60 * 1000;

export function isExplicitSignal(signal: UserSignal): boolean {
  return EXPLICIT_SIGNALS.has(signal);
}

export function isAdmissibleUserEvidence(
  observation: Pick<UserObservation, "actor" | "logicalKey" | "value" | "sessionId">
): boolean {
  return observation.actor === "user"
    && observation.logicalKey.trim().length > 0
    && observation.value.trim().length > 0
    && observation.sessionId.trim().length > 0;
}

export function observationBaseWeight(
  observation: Pick<UserObservation, "actor" | "signal" | "proposedWeight">
): number {
  if (observation.actor !== "user") return 0;

  const maximum = USER_SIGNAL_WEIGHTS[observation.signal];
  if (observation.proposedWeight === undefined) return maximum;
  if (!Number.isFinite(observation.proposedWeight)) return 0;
  return Math.min(maximum, Math.max(0, observation.proposedWeight));
}

export function effectiveObservationWeight(
  observation: Pick<
    UserObservation,
    "actor" | "signal" | "proposedWeight" | "observedAt"
  >,
  now: Date | number | string = Date.now(),
  halfLifeDays: number | null = 90
): number {
  const baseWeight = observationBaseWeight(observation);
  if (baseWeight === 0 || halfLifeDays === null) return baseWeight;
  if (!Number.isFinite(halfLifeDays) || halfLifeDays <= 0) return 0;

  const observedAt = Date.parse(observation.observedAt);
  if (!Number.isFinite(observedAt)) return 0;

  const nowMs = now instanceof Date
    ? now.getTime()
    : typeof now === "string"
      ? Date.parse(now)
      : now;
  if (!Number.isFinite(nowMs)) return 0;
  const ageDays = Math.max(0, nowMs - observedAt) / DAY_MS;
  return baseWeight * Math.pow(0.5, ageDays / halfLifeDays);
}

export function normalizeLogicalKey(logicalKey: string): string {
  return logicalKey.trim().toLocaleLowerCase().replace(/\s+/g, "_");
}

export function normalizeObservationValue(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, " ");
}

export function normalizeScope(scope: UserMemoryScope): UserMemoryScope {
  if (scope.kind === "global") return { kind: "global" };
  const value = scope.value?.trim();
  if (!value) {
    throw new Error(`Scope '${scope.kind}' requires a non-empty value`);
  }
  return { kind: scope.kind, value };
}

export function scopeKey(scope: UserMemoryScope): string {
  const normalized = normalizeScope(scope);
  return normalized.kind === "global"
    ? "global"
    : `${normalized.kind}:${normalized.value!.toLocaleLowerCase()}`;
}

export function sameScope(
  left: UserMemoryScope,
  right: UserMemoryScope
): boolean {
  return scopeKey(left) === scopeKey(right);
}

export function sameObservationValue(
  left: Pick<UserObservation, "value"> | string,
  right: Pick<UserObservation, "value"> | string
): boolean {
  const leftValue = typeof left === "string" ? left : left.value;
  const rightValue = typeof right === "string" ? right : right.value;
  return normalizeObservationValue(leftValue)
    === normalizeObservationValue(rightValue);
}
