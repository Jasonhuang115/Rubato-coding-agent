/**
 * Pure planning logic for a file-backed user model.
 *
 * Nothing in this module writes profile files or advances a CURRENT pointer.
 * It evaluates evidence and returns structured operations for a separate,
 * policy-aware publisher to review and apply.
 */

import {
  effectiveObservationWeight,
  isAdmissibleUserEvidence,
  isExplicitSignal,
  normalizeLogicalKey,
  normalizeObservationValue,
  normalizeScope,
  sameScope,
  type UserMemoryScope,
  type UserObservation,
  type UserSignal,
} from "./observation.js";

export type UserModelStatus =
  | "candidate"
  | "tentative"
  | "provisional"
  | "active"
  | "confirmed"
  | "conflicted"
  | "superseded"
  | "retired"
  | "purged";

export interface UserBelief {
  id: string;
  logicalKey: string;
  value: string;
  scope: UserMemoryScope;
  status: UserModelStatus;
  evidence: UserObservation[];
  /**
   * null pins evidence until it is explicitly contradicted or forgotten.
   */
  halfLifeDays: number | null;
  confidence: number;
  supportScore: number;
  oppositionScore: number;
  createdAt: string;
  updatedAt: string;
  supersededBy?: string;
}

export interface BeliefScore {
  confidence: number;
  supportScore: number;
  oppositionScore: number;
  distinctSessions: number;
  hasExplicitEvidence: boolean;
  hasConfirmationEvidence: boolean;
  hasNonInferenceEvidence: boolean;
  isConflicted: boolean;
}

export interface StatusPatch {
  beliefId: string;
  status: UserModelStatus;
  supersededBy?: string;
}

export type UserModelOperationKind =
  | "ADD"
  | "REINFORCE"
  | "CONTEXTUALIZE"
  | "SUPERSEDE"
  | "CONFLICT"
  | "RECLASSIFY"
  | "RETIRE"
  | "NOOP";

export interface UserModelOperation {
  kind: UserModelOperationKind;
  logicalKey: string;
  scope: UserMemoryScope;
  targetIds: string[];
  evidenceIds: string[];
  proposedBelief?: UserBelief;
  statusPatches: StatusPatch[];
  reason: string;
  /**
   * false means eligible for a deterministic auto-publisher, not that this
   * planner has published anything.
   */
  requiresReview: boolean;
}

export interface CreateBeliefOptions {
  id?: string;
  now?: Date | number | string;
  halfLifeDays?: number | null;
}

export interface PlanUserModelOptions {
  now?: Date | number | string;
  defaultHalfLifeDays?: number | null;
}

export interface BeliefStatusThresholds {
  candidateMax: number;
  activeMin: number;
  provisionalMin: number;
  provisionalSessions: number;
  retireBelow: number;
}

export const DEFAULT_STATUS_THRESHOLDS: Readonly<BeliefStatusThresholds> = {
  candidateMax: 0.65,
  activeMin: 0.80,
  provisionalMin: 0.85,
  provisionalSessions: 3,
  retireBelow: 0.55,
};

const TERMINAL_STATUSES: ReadonlySet<UserModelStatus> = new Set([
  "superseded",
  "retired",
  "purged",
]);

const CONFIRMATION_SIGNALS: ReadonlySet<UserSignal> = new Set([
  "approval",
  "remember",
  "correction",
]);

function nowMs(now: Date | number | string | undefined): number {
  if (now instanceof Date) return now.getTime();
  if (typeof now === "string") return Date.parse(now);
  return now ?? Date.now();
}

function isoTime(now: Date | number | string | undefined): string {
  return new Date(nowMs(now)).toISOString();
}

function signalAuthority(signal: UserSignal): number {
  if (CONFIRMATION_SIGNALS.has(signal)) return 4;
  if (isExplicitSignal(signal)) return 3;
  if (signal === "choice") return 2;
  if (signal === "habit") return 1;
  if (signal === "inference") return 0.5;
  return 0;
}

function latestObservationTime(evidence: UserObservation[]): number {
  let latest = 0;
  for (const observation of evidence) {
    const observedAt = Date.parse(observation.observedAt);
    if (Number.isFinite(observedAt)) latest = Math.max(latest, observedAt);
  }
  return latest;
}

function strongestAuthority(evidence: UserObservation[]): number {
  return evidence.reduce(
    (maximum, observation) =>
      Math.max(maximum, signalAuthority(observation.signal)),
    0
  );
}

function isConfirmationSignal(signal: UserSignal): boolean {
  return CONFIRMATION_SIGNALS.has(signal);
}

function relevantObservation(
  belief: Pick<UserBelief, "logicalKey" | "scope">,
  observation: UserObservation
): boolean {
  return normalizeLogicalKey(observation.logicalKey)
      === normalizeLogicalKey(belief.logicalKey)
    && sameScope(observation.scope, belief.scope);
}

/**
 * Keep at most one observation per session. Within a session, the strongest
 * signal wins; ties go to the latest event. This prevents a long session from
 * manufacturing confidence by repeating the same claim.
 */
function strongestObservationPerSession(
  observations: UserObservation[]
): UserObservation[] {
  const strongest = new Map<string, UserObservation>();
  for (const observation of observations) {
    const previous = strongest.get(observation.sessionId);
    if (!previous) {
      strongest.set(observation.sessionId, observation);
      continue;
    }

    const currentAuthority = signalAuthority(observation.signal);
    const previousAuthority = signalAuthority(previous.signal);
    const isStronger = currentAuthority > previousAuthority;
    const isNewerTie = currentAuthority === previousAuthority
      && Date.parse(observation.observedAt) >= Date.parse(previous.observedAt);
    if (isStronger || isNewerTie) {
      strongest.set(observation.sessionId, observation);
    }
  }
  return [...strongest.values()];
}

export function scoreBelief(
  belief: Pick<
    UserBelief,
    "logicalKey" | "value" | "scope" | "evidence" | "halfLifeDays"
  >,
  now: Date | number | string = Date.now()
): BeliefScore {
  const admissible = belief.evidence.filter(
    (observation) =>
      isAdmissibleUserEvidence(observation)
      && relevantObservation(belief, observation)
  );
  const observations = strongestObservationPerSession(admissible);

  let supportScore = 0;
  let oppositionScore = 0;
  let hasExplicitEvidence = false;
  let hasConfirmationEvidence = false;
  let hasNonInferenceEvidence = false;
  const expectedValue = normalizeObservationValue(belief.value);

  for (const observation of observations) {
    const weight = effectiveObservationWeight(
      observation,
      now,
      belief.halfLifeDays
    );
    const sameValue =
      normalizeObservationValue(observation.value) === expectedValue;

    if (sameValue && observation.polarity === "support") {
      supportScore += weight;
      hasExplicitEvidence ||= isExplicitSignal(observation.signal);
      hasConfirmationEvidence ||=
        isConfirmationSignal(observation.signal);
      hasNonInferenceEvidence ||=
        observation.signal !== "inference"
        && observation.signal !== "other";
    } else if (
      (sameValue && observation.polarity === "oppose")
      || (!sameValue && observation.polarity === "support")
    ) {
      oppositionScore += weight;
    }
  }

  const confidence = (1 + supportScore)
    / (2 + supportScore + oppositionScore);
  const weakerSide = Math.min(supportScore, oppositionScore);
  const strongerSide = Math.max(supportScore, oppositionScore);
  const conflictRatio = strongerSide === 0 ? 0 : weakerSide / strongerSide;

  return {
    confidence,
    supportScore,
    oppositionScore,
    distinctSessions: observations.length,
    hasExplicitEvidence,
    hasConfirmationEvidence,
    hasNonInferenceEvidence,
    isConflicted:
      supportScore > 0
      && oppositionScore > 0
      && conflictRatio >= 0.5,
  };
}

export function deriveBeliefStatus(
  score: BeliefScore,
  thresholds: BeliefStatusThresholds = DEFAULT_STATUS_THRESHOLDS
): UserModelStatus {
  if (score.isConflicted) return "conflicted";
  if (
    score.hasConfirmationEvidence
    && score.confidence >= thresholds.activeMin
  ) {
    return "confirmed";
  }
  if (
    score.hasExplicitEvidence
    && score.confidence >= thresholds.activeMin
  ) {
    return "active";
  }
  if (
    score.confidence >= thresholds.provisionalMin
    && score.distinctSessions >= thresholds.provisionalSessions
    && score.hasNonInferenceEvidence
  ) {
    return "provisional";
  }
  if (score.confidence >= thresholds.candidateMax) return "tentative";
  return "candidate";
}

function validatedEvidence(observations: UserObservation[]): UserObservation[] {
  if (observations.length === 0) {
    throw new Error("A user belief requires at least one observation");
  }
  const first = observations[0];
  const logicalKey = normalizeLogicalKey(first.logicalKey);
  const scope = normalizeScope(first.scope);
  const admissible = observations.filter(
    (observation) =>
      isAdmissibleUserEvidence(observation)
      && normalizeLogicalKey(observation.logicalKey) === logicalKey
      && sameScope(observation.scope, scope)
  );
  if (admissible.length === 0) {
    throw new Error("A user belief requires admissible user evidence");
  }
  return admissible;
}

export function createBelief(
  observations: UserObservation[],
  options: CreateBeliefOptions = {}
): UserBelief {
  const evidence = validatedEvidence(observations);
  const first = evidence[0];
  const createdAt = isoTime(options.now);
  const hasConfirmation = evidence.some((observation) =>
    isConfirmationSignal(observation.signal)
  );
  const halfLifeDays = options.halfLifeDays !== undefined
    ? options.halfLifeDays
    : hasConfirmation
      ? null
      : 90;

  const draft: UserBelief = {
    id: options.id ?? `belief_${first.id}`,
    logicalKey: normalizeLogicalKey(first.logicalKey),
    value: first.value.trim(),
    scope: normalizeScope(first.scope),
    status: "candidate",
    evidence,
    halfLifeDays,
    confidence: 0.5,
    supportScore: 0,
    oppositionScore: 0,
    createdAt,
    updatedAt: createdAt,
  };
  return refreshBelief(draft, options.now);
}

export function refreshBelief(
  belief: UserBelief,
  now: Date | number | string = Date.now()
): UserBelief {
  const score = scoreBelief(belief, now);
  const status = TERMINAL_STATUSES.has(belief.status)
    ? belief.status
    : deriveBeliefStatus(score);
  return {
    ...belief,
    status,
    confidence: score.confidence,
    supportScore: score.supportScore,
    oppositionScore: score.oppositionScore,
    updatedAt: new Date(nowMs(now)).toISOString(),
  };
}

function addEvidence(
  belief: UserBelief,
  observation: UserObservation,
  now: Date | number | string
): UserBelief {
  const evidenceById = new Map(
    belief.evidence.map((item) => [item.id, item])
  );
  evidenceById.set(observation.id, observation);
  return refreshBelief(
    {
      ...belief,
      evidence: [...evidenceById.values()],
      halfLifeDays: isConfirmationSignal(observation.signal)
        ? null
        : belief.halfLifeDays,
    },
    now
  );
}

function requiresReview(observation: UserObservation): boolean {
  return !isConfirmationSignal(observation.signal);
}

function operation(
  kind: UserModelOperationKind,
  observation: UserObservation,
  reason: string,
  fields: Partial<
    Pick<
      UserModelOperation,
      "targetIds" | "proposedBelief" | "statusPatches" | "requiresReview"
    >
  > = {}
): UserModelOperation {
  return {
    kind,
    logicalKey: normalizeLogicalKey(observation.logicalKey),
    scope: normalizeScope(observation.scope),
    targetIds: fields.targetIds ?? [],
    evidenceIds: [observation.id],
    proposedBelief: fields.proposedBelief,
    statusPatches: fields.statusPatches ?? [],
    reason,
    requiresReview:
      fields.requiresReview ?? requiresReview(observation),
  };
}

function beliefMatchesObservation(
  belief: UserBelief,
  observation: UserObservation
): boolean {
  return normalizeLogicalKey(belief.logicalKey)
      === normalizeLogicalKey(observation.logicalKey)
    && sameScope(belief.scope, observation.scope);
}

function choosePrimaryBelief(beliefs: UserBelief[]): UserBelief {
  return [...beliefs].sort((left, right) => {
    const statusRank: Record<UserModelStatus, number> = {
      confirmed: 9,
      active: 8,
      provisional: 7,
      tentative: 6,
      candidate: 5,
      conflicted: 4,
      superseded: 3,
      retired: 2,
      purged: 1,
    };
    const statusDifference =
      statusRank[right.status] - statusRank[left.status];
    if (statusDifference !== 0) return statusDifference;
    return Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
  })[0];
}

function replaceWorkingBelief(
  working: UserBelief[],
  replacement: UserBelief
): void {
  const index = working.findIndex((belief) => belief.id === replacement.id);
  if (index >= 0) working[index] = replacement;
  else working.push(replacement);
}

function patchWorkingStatuses(
  working: UserBelief[],
  patches: StatusPatch[]
): void {
  for (const patch of patches) {
    const index = working.findIndex((belief) => belief.id === patch.beliefId);
    if (index < 0) continue;
    working[index] = {
      ...working[index],
      status: patch.status,
      supersededBy: patch.supersededBy,
    };
  }
}

/**
 * Plans changes for observations in order. A private working set is updated so
 * two observations in the same batch do not produce duplicate ADD operations;
 * the caller's beliefs are never mutated.
 */
export function planUserModelOperations(
  existing: UserBelief[],
  incoming: UserObservation[],
  options: PlanUserModelOptions = {}
): UserModelOperation[] {
  const now = nowMs(options.now);
  const working = existing.map((belief) => ({
    ...belief,
    evidence: [...belief.evidence],
  }));
  const operations: UserModelOperation[] = [];

  for (const observation of incoming) {
    if (!isAdmissibleUserEvidence(observation)) {
      operations.push(operation(
        "NOOP",
        observation,
        "Only user-authored observations are admissible evidence",
        { requiresReview: false }
      ));
      continue;
    }

    const exactMatches = working.filter(
      (belief) =>
        !TERMINAL_STATUSES.has(belief.status)
        && beliefMatchesObservation(belief, observation)
    );
    const sameKeyOtherScope = working.filter(
      (belief) =>
        !TERMINAL_STATUSES.has(belief.status)
        && normalizeLogicalKey(belief.logicalKey)
          === normalizeLogicalKey(observation.logicalKey)
        && !sameScope(belief.scope, observation.scope)
    );

    if (exactMatches.length === 0) {
      const proposedBelief = createBelief([observation], {
        now,
        halfLifeDays: options.defaultHalfLifeDays,
      });
      const kind = sameKeyOtherScope.length > 0
        ? "CONTEXTUALIZE"
        : "ADD";
      const planned = operation(
        kind,
        observation,
        kind === "CONTEXTUALIZE"
          ? "The logical key exists in another scope; keep a scoped variant"
          : "No belief exists for this logical key and scope",
        {
          targetIds: sameKeyOtherScope.map((belief) => belief.id),
          proposedBelief,
        }
      );
      operations.push(planned);
      working.push(proposedBelief);
      continue;
    }

    const sameValue = exactMatches.filter(
      (belief) =>
        normalizeObservationValue(belief.value)
        === normalizeObservationValue(observation.value)
    );
    if (sameValue.length > 0) {
      const current = choosePrimaryBelief(sameValue);
      const proposedBelief = addEvidence(current, observation, now);
      const planned = operation(
        "REINFORCE",
        observation,
        "The observation supports an existing belief",
        { targetIds: [current.id], proposedBelief }
      );
      operations.push(planned);
      replaceWorkingBelief(working, proposedBelief);
      continue;
    }

    const current = choosePrimaryBelief(exactMatches);
    const incomingAuthority = signalAuthority(observation.signal);
    const existingAuthority = strongestAuthority(current.evidence);
    const incomingTime = Date.parse(observation.observedAt);
    const existingTime = latestObservationTime(current.evidence);
    const currentIsConfirmed = current.status === "confirmed"
      || existingAuthority >= 4;
    const isExplicitCurrentChange =
      incomingAuthority >= 3 && incomingTime > existingTime;
    const shouldSupersede =
      incomingAuthority >= 4
      || incomingAuthority > existingAuthority
      || (
        incomingAuthority === existingAuthority
        && isExplicitCurrentChange
      );

    if (shouldSupersede) {
      const proposedBelief = createBelief([observation], {
        now,
        halfLifeDays: options.defaultHalfLifeDays,
      });
      const patches: StatusPatch[] = exactMatches.map((belief) => ({
        beliefId: belief.id,
        status: "superseded",
        supersededBy: proposedBelief.id,
      }));
      const planned = operation(
        "SUPERSEDE",
        observation,
        "Newer or more authoritative user evidence replaces the same scoped key",
        {
          targetIds: exactMatches.map((belief) => belief.id),
          proposedBelief,
          statusPatches: patches,
        }
      );
      operations.push(planned);
      patchWorkingStatuses(working, patches);
      working.push(proposedBelief);
      continue;
    }

    if (incomingAuthority < 3 && currentIsConfirmed) {
      operations.push(operation(
        "NOOP",
        observation,
        "Weaker implicit evidence cannot override a confirmed belief",
        { targetIds: [current.id], requiresReview: false }
      ));
      continue;
    }

    const proposedBelief = {
      ...createBelief([observation], {
        now,
        halfLifeDays: options.defaultHalfLifeDays,
      }),
      status: "conflicted" as const,
    };
    const patches: StatusPatch[] = exactMatches.map((belief) => ({
      beliefId: belief.id,
      status: "conflicted",
    }));
    const planned = operation(
      "CONFLICT",
      observation,
      "Conflicting evidence has comparable authority and needs reconciliation",
      {
        targetIds: exactMatches.map((belief) => belief.id),
        proposedBelief,
        statusPatches: patches,
        requiresReview: true,
      }
    );
    operations.push(planned);
    patchWorkingStatuses(working, patches);
    working.push(proposedBelief);
  }

  return operations;
}
