import { createHash } from "crypto";
import type { StoredSessionRecord } from "../runtime/session/storage.js";
import {
  extractUserObservations,
  type ObservationProposal,
  type SourceEvent,
} from "./extractor.js";
import { proposeFastUserObservations } from "./fast-extractor.js";
import {
  isExplicitSignal,
  normalizeLogicalKey,
  normalizeObservationValue,
  sameScope,
  type UserMemoryScope,
  type UserObservation,
  type UserSignal,
} from "./observation.js";
import {
  findMemorySafetyIssues,
  loadMemoryPolicy,
} from "./policy.js";
import {
  FileMemoryRepository,
  operationDigest,
  type CandidateRisk,
  type MemoryCandidate,
} from "./repository.js";
import {
  listCurrentCards,
  publishMemoryRelease,
  readCurrentReleaseId,
} from "./release.js";
import type {
  MemoryCard,
  MemoryChange,
  MemoryEvidence,
  MemoryKind,
  MemoryScopePaths,
  MemoryStatus,
} from "./types.js";
import {
  planUserModelOperations,
  refreshBelief,
  type UserBelief,
  type UserModelOperation,
} from "./user-model.js";

export interface FileMemoryLearningOptions {
  workingDir: string;
  rootDir?: string;
  enabled?: boolean;
  /** Per-runtime override; both this and the durable policy must allow it. */
  autoPublishExplicitLowRisk?: boolean;
  sessionId?: string;
  /**
   * Dreaming sets this to false: model-derived proposals may create
   * observations/candidates, but cannot advance CURRENT or quarantine cards.
   */
  allowPublishing?: boolean;
  /** Re-run the reducer for already-persisted observations after a worker crash. */
  reprocessDuplicates?: boolean;
  /** Stable planning clock used to make retry candidate digests idempotent. */
  now?: Date | number | string;
}

export interface FileMemoryLearningResult {
  observed: number;
  duplicates: number;
  candidates: MemoryCandidate[];
  publishedReleaseIds: string[];
  needsReview: number;
  skipped: string[];
}

export interface DeterministicDreamPublicationOptions {
  workingDir: string;
  rootDir?: string;
  verifiedEvents: SourceEvent[];
  now?: Date | number | string;
}

export interface DeterministicDreamPublicationResult {
  publishedReleaseIds: string[];
  publishedCandidateIds: string[];
  reviewCandidateIds: string[];
  rejectedCandidateIds: string[];
  reasons: string[];
}

export function sourceEventsFromSessionRecords(
  records: ReadonlyArray<StoredSessionRecord>,
  sessionId?: string,
): SourceEvent[] {
  const events: SourceEvent[] = [];
  for (const record of records) {
    if (record.type !== "message") continue;
    const message = record.data as {
      role?: unknown;
      content?: unknown;
    };
    if (message?.role !== "user") continue;
    const content = userAuthoredText(message.content);
    if (!content) continue;
    events.push({
      id: record.event_id,
      actor: "user",
      content,
      sessionId: sessionId ?? sessionIdFromRecord(records, record),
      observedAt: new Date(record.timestamp).toISOString(),
      eventSeq: record.seq,
      eventHash: record.hash,
    });
  }
  return events;
}

/**
 * Fast root-session learner. This function never calls a model: it handles
 * explicit low-risk statements and leaves broader inference to Dreaming.
 */
export function learnFromUserEvents(
  events: SourceEvent[],
  options: FileMemoryLearningOptions,
): FileMemoryLearningResult {
  const repository = new FileMemoryRepository({
    rootDir: options.rootDir,
    projectDir: options.workingDir,
  });
  const fast = proposeFastUserObservations(events, {
    projectId: repository.projectId,
  });
  return learnFromObservationProposalsInternal(
    events,
    fast.proposals,
    options,
    fast.skipped.map((item) => `${item.eventId}:${item.reason}`),
    repository,
  );
}

/**
 * Validates model/tool proposals against their original user events before
 * entering the same deterministic reducer used by the fast path.
 */
export function learnFromObservationProposals(
  events: SourceEvent[],
  proposals: ObservationProposal[],
  options: FileMemoryLearningOptions,
): FileMemoryLearningResult {
  return learnFromObservationProposalsInternal(
    events,
    proposals,
    options,
    [],
  );
}

function learnFromObservationProposalsInternal(
  events: SourceEvent[],
  proposals: ObservationProposal[],
  options: FileMemoryLearningOptions,
  initialSkipped: string[],
  existingRepository?: FileMemoryRepository,
): FileMemoryLearningResult {
  const result: FileMemoryLearningResult = {
    observed: 0,
    duplicates: 0,
    candidates: [],
    publishedReleaseIds: [],
    needsReview: 0,
    skipped: [...initialSkipped],
  };
  const policy = loadMemoryPolicy();
  if (options.enabled === false || !policy.learning_enabled) {
    result.skipped.push("memory_learning_paused");
    return result;
  }

  const repository = existingRepository ?? new FileMemoryRepository({
    rootDir: options.rootDir,
    projectDir: options.workingDir,
  });
  const extracted = extractUserObservations(events, proposals);
  result.skipped.push(...extracted.rejected.map((item) =>
    `${item.proposal.sourceEventId}:${item.reason}`));

  const fresh: UserObservation[] = [];
  for (const observation of extracted.accepted) {
    try {
      const persisted = repository.appendObservation(observation);
      if (persisted.written) {
        fresh.push(observation);
        result.observed++;
      } else {
        result.duplicates++;
        if (options.reprocessDuplicates) fresh.push(observation);
      }
    } catch (error) {
      result.skipped.push(
        `${observation.id}:${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  const groups = new Map<string, {
    paths: MemoryScopePaths;
    observations: UserObservation[];
    defaultHalfLifeDays: number | null;
  }>();
  for (const observation of fresh) {
    const paths = repository.pathsForScope(observation.scope);
    const defaultHalfLifeDays = confirmationSignal(observation.signal)
      ? null
      : halfLifeFor(observation);
    const groupKey = `${paths.scope}\u001f${defaultHalfLifeDays ?? "pinned"}`;
    const group = groups.get(groupKey) ?? {
      paths,
      observations: [],
      defaultHalfLifeDays,
    };
    group.observations.push(observation);
    groups.set(groupKey, group);
  }

  const observationsById = new Map(fresh.map((item) => [item.id, item]));
  for (const group of groups.values()) {
    const { paths } = group;
    const cards = safeCurrentCards(paths);
    const observations = repository.listObservations(
      paths.scope === "project" ? "project" : "global",
    );
    const beliefs = cardsToBeliefs(cards, observations, repository.projectId);
    const operations = planUserModelOperations(
      beliefs,
      group.observations,
      {
        defaultHalfLifeDays: group.defaultHalfLifeDays,
        now: options.now,
      },
    );

    for (const operation of operations) {
      const observation = observationsById.get(operation.evidenceIds[0]);
      if (!observation) {
        result.skipped.push(
          `${operation.logicalKey}:operation missing fresh evidence`,
        );
        continue;
      }
      if (operation.kind === "NOOP") {
        result.skipped.push(`${observation.id}:${operation.reason}`);
        continue;
      }
      const risk = operationRisk(operation);
      const autoPublish = isAutoPublishable(
        operation,
        observation,
        risk,
        options.allowPublishing !== false &&
          policy.auto_publish_explicit_low_risk &&
          options.autoPublishExplicitLowRisk !== false,
      );
      const candidate = repository.writeCandidate(
        operation,
        risk,
        autoPublish ? "pending" : "review",
      );
      result.candidates.push(candidate);

      if (!autoPublish) {
        result.needsReview++;
        if (
          options.allowPublishing !== false &&
          operation.kind === "CONFLICT"
        ) {
          const releaseId = quarantineConflictingCards(
            paths,
            operation,
          );
          if (releaseId) result.publishedReleaseIds.push(releaseId);
        }
        continue;
      }

      try {
        const releaseId = applyOperation(repository, paths, operation);
        repository.moveCandidate(candidate.id, "published");
        result.publishedReleaseIds.push(releaseId);
      } catch (error) {
        result.needsReview++;
        repository.moveCandidate(
          candidate.id,
          "review",
          `automatic publish failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }
  return result;
}

/**
 * Second, model-independent half of Dreaming.
 *
 * The LLM-facing worker can only persist observations and review candidates.
 * This gate reloads their immutable evidence, re-derives belief status, risk,
 * and safety from deterministic code, then publishes only low-risk active or
 * provisional beliefs. A candidate file cannot grant itself authority.
 */
export function publishDeterministicDreamCandidates(
  candidates: MemoryCandidate[],
  options: DeterministicDreamPublicationOptions,
): DeterministicDreamPublicationResult {
  const result: DeterministicDreamPublicationResult = {
    publishedReleaseIds: [],
    publishedCandidateIds: [],
    reviewCandidateIds: [],
    rejectedCandidateIds: [],
    reasons: [],
  };
  const repository = new FileMemoryRepository({
    rootDir: options.rootDir,
    projectDir: options.workingDir,
  });
  const verifiedEvents = new Map(
    options.verifiedEvents.map((event) => [event.id, event]),
  );
  const uniqueCandidates = [...new Map(
    candidates.map((candidate) => [candidate.id, candidate]),
  ).values()];
  const evaluated: EvaluatedDreamCandidate[] = [];

  for (const candidate of uniqueCandidates) {
    try {
      evaluated.push(evaluateDreamCandidate(
        candidate,
        repository,
        verifiedEvents,
        options.now,
      ));
    } catch (error) {
      addUnique(result.reviewCandidateIds, candidate.id);
      result.reasons.push(
        `${candidate.id}:${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  const groups = new Map<string, EvaluatedDreamCandidate[]>();
  for (const item of evaluated) {
    const key = [
      normalizeLogicalKey(item.belief.logicalKey),
      memoryScopeKey(item.belief.scope),
    ].join("\u001f");
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }

  for (const group of groups.values()) {
    const values = new Set(group.map((item) =>
      normalizeObservationValue(item.belief.value)));
    if (values.size !== 1) {
      for (const item of group) {
        addUnique(result.reviewCandidateIds, item.candidate.id);
      }
      result.reasons.push(
        `${group[0].candidate.logical_key}:conflicting Dream candidate values`,
      );
      continue;
    }

    const eligible = group.filter((item) =>
      item.risk === "low" &&
      (
        item.belief.status === "provisional" ||
        item.belief.status === "active"
      ) &&
      (
        item.candidate.operation === "ADD" ||
        item.candidate.operation === "REINFORCE" ||
        item.candidate.operation === "CONTEXTUALIZE"
      ));
    if (eligible.length === 0) {
      for (const item of group) {
        addUnique(result.reviewCandidateIds, item.candidate.id);
      }
      result.reasons.push(
        `${group[0].candidate.logical_key}:no low-risk active or provisional candidate`,
      );
      continue;
    }

    const selected = [...eligible].sort(compareDreamCandidates)[0];
    try {
      const releaseId = publishEvaluatedDreamCandidate(
        selected,
        repository,
      );
      addUnique(result.publishedReleaseIds, releaseId);
      addUnique(result.publishedCandidateIds, selected.candidate.id);
      if (selected.candidate.state !== "published") {
        repository.moveCandidate(selected.candidate.id, "published");
      }
      for (const item of group) {
        if (
          item.candidate.id === selected.candidate.id ||
          item.candidate.state === "published"
        ) {
          continue;
        }
        repository.moveCandidate(
          item.candidate.id,
          "rejected",
          `Superseded by deterministic Dream candidate ${selected.candidate.id}`,
        );
        addUnique(result.rejectedCandidateIds, item.candidate.id);
      }
    } catch (error) {
      for (const item of group) {
        addUnique(result.reviewCandidateIds, item.candidate.id);
      }
      result.reasons.push(
        `${selected.candidate.id}:${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  result.publishedCandidateIds.sort();
  result.reviewCandidateIds.sort();
  result.rejectedCandidateIds.sort();
  result.reasons.sort();
  return result;
}

interface EvaluatedDreamCandidate {
  candidate: MemoryCandidate;
  belief: UserBelief;
  risk: CandidateRisk;
}

function evaluateDreamCandidate(
  candidate: MemoryCandidate,
  repository: FileMemoryRepository,
  verifiedEvents: Map<string, SourceEvent>,
  now: Date | number | string | undefined,
): EvaluatedDreamCandidate {
  if (
    candidate.state !== "pending" &&
    candidate.state !== "review" &&
    candidate.state !== "published"
  ) {
    throw new Error(`candidate state ${candidate.state} is not publishable`);
  }
  const persistedOperation = operationFromCandidate(candidate);
  const digest = operationDigest(persistedOperation);
  if (
    digest !== candidate.input_digest ||
    candidate.id !== `candidate_${digest.slice(0, 24)}`
  ) {
    throw new Error("candidate digest does not match its deterministic operation");
  }
  const safetyIssues = findMemorySafetyIssues(JSON.stringify(candidate));
  if (safetyIssues.length > 0) {
    throw new Error(`candidate failed safety validation: ${safetyIssues.join(", ")}`);
  }
  const proposed = candidate.proposed_belief;
  if (!proposed) throw new Error("candidate has no proposed belief");
  if (
    normalizeLogicalKey(proposed.logicalKey) !==
      normalizeLogicalKey(candidate.logical_key) ||
    !sameScope(proposed.scope, candidate.scope)
  ) {
    throw new Error("candidate belief does not match its key or scope");
  }
  if (
    candidate.scope.kind === "project" &&
    candidate.project_id !== repository.projectId
  ) {
    throw new Error("candidate escaped the current project");
  }

  const scopeKind = candidate.scope.kind === "project" ? "project" : "global";
  const observations = repository.listObservations(scopeKind);
  const observationById = new Map(
    observations.map((observation) => [observation.id, observation]),
  );
  const paths = repository.pathsForScope(candidate.scope);
  const currentCards = listCurrentCards(paths);
  const canonicalEvidence = proposed.evidence.map((item) => {
    const persisted = observationById.get(item.id);
    if (!persisted || !sameObservation(item, persisted)) {
      throw new Error(`belief evidence is not an immutable observation: ${item.id}`);
    }
    if (
      !observationMatchesVerifiedEvent(persisted, verifiedEvents) &&
      !observationMatchesCurrentCard(
        persisted,
        currentCards,
        repository.projectId,
      )
    ) {
      throw new Error(`belief evidence is not bound to this Dream or CURRENT: ${item.id}`);
    }
    return persisted;
  });
  const evidenceById = new Map(
    canonicalEvidence.map((observation) => [observation.id, observation]),
  );
  if (
    candidate.evidence_ids.length === 0 ||
    candidate.evidence_ids.some((id) => !evidenceById.has(id))
  ) {
    throw new Error("candidate evidence_ids are not present in its belief");
  }
  const belief = refreshBelief({
    ...proposed,
    status: "candidate",
    evidence: [...evidenceById.values()],
  }, now);
  const sanitizedOperation: UserModelOperation = {
    ...persistedOperation,
    logicalKey: belief.logicalKey,
    scope: belief.scope,
    proposedBelief: belief,
  };
  const risk = operationRisk(sanitizedOperation);
  if (risk !== candidate.risk) {
    throw new Error("candidate risk does not match deterministic classification");
  }
  return { candidate, belief, risk };
}

function publishEvaluatedDreamCandidate(
  item: EvaluatedDreamCandidate,
  repository: FileMemoryRepository,
): string {
  const paths = repository.pathsForScope(item.belief.scope);
  const currentCards = listCurrentCards(paths);
  const scopedCards = currentCards.filter((card) =>
    normalizeLogicalKey(card.logicalKey) ===
      normalizeLogicalKey(item.belief.logicalKey) &&
    sameScope(userScopeForCard(card, repository.projectId), item.belief.scope));
  const matching = scopedCards.find((card) =>
    normalizeObservationValue(card.body) ===
      normalizeObservationValue(item.belief.value));
  if (scopedCards.length > 0 && !matching) {
    throw new Error("Dreaming cannot automatically replace a different CURRENT value");
  }

  if (
    matching &&
    cardContainsBelief(matching, item.belief) &&
    matching.status === item.belief.status
  ) {
    const existingReleaseId = readCurrentReleaseId(paths);
    if (!existingReleaseId) {
      throw new Error("matching CURRENT card has no verified release");
    }
    return existingReleaseId;
  }

  const operation: UserModelOperation = {
    kind: matching ? "REINFORCE" : "ADD",
    logicalKey: item.belief.logicalKey,
    scope: item.belief.scope,
    targetIds: matching ? [matching.id] : [],
    evidenceIds: item.belief.evidence.map((evidence) => evidence.id).sort(),
    proposedBelief: item.belief,
    statusPatches: [],
    reason:
      `Deterministic Dream publication from candidate ${item.candidate.id}`,
    requiresReview: false,
  };
  if (
    operationRisk(operation) !== "low" ||
    findMemorySafetyIssues(JSON.stringify(operation)).length > 0
  ) {
    throw new Error("sanitized Dream operation did not pass low-risk safety policy");
  }
  return applyOperation(repository, paths, operation);
}

function operationFromCandidate(
  candidate: MemoryCandidate,
): UserModelOperation {
  return {
    kind: candidate.operation,
    logicalKey: candidate.logical_key,
    scope: candidate.scope,
    targetIds: candidate.target_ids,
    evidenceIds: candidate.evidence_ids,
    proposedBelief: candidate.proposed_belief,
    statusPatches: candidate.status_patches,
    reason: candidate.reason,
    requiresReview: candidate.requires_review,
  };
}

function observationMatchesVerifiedEvent(
  observation: UserObservation,
  verifiedEvents: Map<string, SourceEvent>,
): boolean {
  if (!observation.eventId) return false;
  const event = verifiedEvents.get(observation.eventId);
  return Boolean(
    event &&
    event.actor === "user" &&
    event.sessionId === observation.sessionId &&
    event.eventSeq === observation.eventSeq &&
    event.eventHash === observation.eventHash,
  );
}

function observationMatchesCurrentCard(
  observation: UserObservation,
  cards: MemoryCard[],
  projectId: string,
): boolean {
  return cards.some((card) =>
    normalizeLogicalKey(card.logicalKey) ===
      normalizeLogicalKey(observation.logicalKey) &&
    normalizeObservationValue(card.body) ===
      normalizeObservationValue(observation.value) &&
    sameScope(userScopeForCard(card, projectId), observation.scope) &&
    card.evidence.some((evidence) =>
      evidence.actor === "user" &&
      evidence.sessionId === observation.sessionId &&
      evidence.eventSeq === observation.eventSeq &&
      evidence.eventHash === observation.eventHash));
}

function sameObservation(
  left: UserObservation,
  right: UserObservation,
): boolean {
  return left.id === right.id &&
    left.actor === right.actor &&
    left.signal === right.signal &&
    normalizeLogicalKey(left.logicalKey) === normalizeLogicalKey(right.logicalKey) &&
    normalizeObservationValue(left.value) === normalizeObservationValue(right.value) &&
    sameScope(left.scope, right.scope) &&
    left.polarity === right.polarity &&
    left.sessionId === right.sessionId &&
    left.eventId === right.eventId &&
    left.eventSeq === right.eventSeq &&
    left.eventHash === right.eventHash &&
    left.observedAt === right.observedAt &&
    left.proposedWeight === right.proposedWeight;
}

function cardContainsBelief(card: MemoryCard, belief: UserBelief): boolean {
  return belief.evidence.every((observation) =>
    card.evidence.some((evidence) =>
      evidence.actor === "user" &&
      evidence.sessionId === observation.sessionId &&
      evidence.eventSeq === observation.eventSeq &&
      evidence.eventHash === observation.eventHash));
}

function memoryScopeKey(scope: UserMemoryScope): string {
  return `${scope.kind}:${scope.value ?? ""}`;
}

function compareDreamCandidates(
  left: EvaluatedDreamCandidate,
  right: EvaluatedDreamCandidate,
): number {
  const rank = (belief: UserBelief): number =>
    belief.status === "active" ? 2 : belief.status === "provisional" ? 1 : 0;
  return rank(right.belief) - rank(left.belief) ||
    right.belief.evidence.length - left.belief.evidence.length ||
    right.belief.supportScore - left.belief.supportScore ||
    right.belief.updatedAt.localeCompare(left.belief.updatedAt) ||
    left.candidate.id.localeCompare(right.candidate.id);
}

function addUnique(values: string[], value: string): void {
  if (!values.includes(value)) values.push(value);
}

export function learnFromStoredSessionRecords(
  records: ReadonlyArray<StoredSessionRecord>,
  options: FileMemoryLearningOptions,
): FileMemoryLearningResult {
  return learnFromUserEvents(
    sourceEventsFromSessionRecords(records, options.sessionId),
    options,
  );
}

function applyOperation(
  repository: FileMemoryRepository,
  paths: MemoryScopePaths,
  operation: UserModelOperation,
): string {
  const currentId = readCurrentReleaseId(paths);
  const currentCards = safeCurrentCards(paths);
  const changes = operationToChanges(
    operation,
    currentCards,
    paths,
    repository.projectId,
  );
  if (changes.length === 0) {
    throw new Error(`Operation ${operation.kind} produced no release changes`);
  }
  return publishMemoryRelease(paths, {
    baseReleaseId: currentId,
    changes,
    reason:
      `Deterministic ${operation.kind} from user evidence ` +
      operation.evidenceIds.join(","),
  }).id;
}

function quarantineConflictingCards(
  paths: MemoryScopePaths,
  operation: UserModelOperation,
): string | null {
  const cards = safeCurrentCards(paths);
  const targets = cards.filter((card) => operation.targetIds.includes(card.id));
  if (targets.length === 0) return null;
  const changes: MemoryChange[] = targets.map((card) => ({
    type: "revise",
    expectedRevision: card.revision,
    card: {
      ...card,
      revision: card.revision + 1,
      status: "conflicted",
      application: "reference",
      updatedAt: new Date().toISOString(),
      conflicts: [...new Set([
        ...card.conflicts,
        operation.proposedBelief?.id ?? operation.logicalKey,
      ])],
    },
  }));
  return publishMemoryRelease(paths, {
    baseReleaseId: readCurrentReleaseId(paths),
    changes,
    reason: `Quarantine conflicting memory ${operation.logicalKey}`,
  }).id;
}

function operationToChanges(
  operation: UserModelOperation,
  currentCards: MemoryCard[],
  paths: MemoryScopePaths,
  projectId: string,
): MemoryChange[] {
  const belief = operation.proposedBelief;
  if (!belief) return [];
  const targets = currentCards.filter((card) =>
    operation.targetIds.includes(card.id));

  if (operation.kind === "ADD" || operation.kind === "CONTEXTUALIZE") {
    return [{
      type: "create",
      card: beliefToCard(belief, paths, projectId),
    }];
  }
  if (operation.kind === "REINFORCE" || operation.kind === "RECLASSIFY") {
    const current = targets[0] ??
      currentCards.find((card) => card.logicalKey === operation.logicalKey);
    if (!current) return [];
    return [{
      type: "revise",
      expectedRevision: current.revision,
      card: beliefToCard(belief, paths, projectId, current),
    }];
  }
  if (operation.kind === "SUPERSEDE") {
    return [{
      type: "supersede",
      ...(targets.length === 1
        ? { expectedRevision: targets[0].revision }
        : {}),
      card: beliefToCard(
        belief,
        paths,
        projectId,
        undefined,
        targets,
      ),
    }];
  }
  if (operation.kind === "RETIRE") {
    return [{
      type: "retire",
      logicalKey: operation.logicalKey,
      ...(targets.length === 1
        ? { expectedRevision: targets[0].revision }
        : {}),
    }];
  }
  return [];
}

function beliefToCard(
  belief: UserBelief,
  paths: MemoryScopePaths,
  projectId: string,
  current?: MemoryCard,
  superseded: MemoryCard[] = [],
): MemoryCard {
  const now = new Date().toISOString();
  const evidence = belief.evidence
    .filter((item) =>
      item.actor === "user" &&
      Number.isInteger(item.eventSeq) &&
      Boolean(item.eventHash))
    .map((item): MemoryEvidence => ({
      sessionId: item.sessionId,
      eventSeq: item.eventSeq!,
      eventHash: item.eventHash!,
      actor: "user",
      signal: item.signal,
    }));
  if (evidence.length === 0) {
    throw new Error("A published user memory requires verifiable user evidence");
  }
  const status = cardStatus(belief.status);
  const id = current?.id ?? safeCardId(belief.id);
  const contexts = scopeContexts(belief.scope, projectId);
  const lastSeenAt = latestEvidenceTime(belief.evidence) ?? belief.updatedAt;
  const firstSeenAt = earliestEvidenceTime(belief.evidence) ?? belief.createdAt;
  const confirmed = belief.evidence
    .filter((item) => confirmationSignal(item.signal))
    .map((item) => item.observedAt)
    .sort()
    .at(-1);
  const kind = memoryKind(belief);
  return {
    schemaVersion: 1,
    id,
    revision: current ? current.revision + 1 : 1,
    logicalKey: belief.logicalKey,
    kind,
    scope: paths.scope,
    status,
    origin: belief.evidence.some((item) => isExplicitSignal(item.signal))
      ? "explicit"
      : "inferred",
    application: applicationFor(kind, status),
    authority: belief.evidence.some((item) => isExplicitSignal(item.signal))
      ? "user_explicit"
      : "user_inferred",
    sensitivity:
      kind === "identity" || kind === "interest" ? "personal" : "normal",
    confidence: belief.confidence,
    supportScore: belief.supportScore,
    oppositionScore: belief.oppositionScore,
    halfLifeDays: belief.halfLifeDays,
    title: titleForLogicalKey(belief.logicalKey),
    body: belief.value.trim(),
    conditions: conditionLabels(belief.scope),
    exceptions: ["The current user's request and current-session instructions override this memory."],
    aliases: aliasesFor(belief),
    tags: tagsFor(belief),
    contexts,
    createdAt: current?.createdAt ?? belief.createdAt,
    updatedAt: now,
    firstSeenAt: current?.firstSeenAt ?? firstSeenAt,
    lastSeenAt,
    ...(confirmed ? { lastConfirmedAt: confirmed } : {}),
    ...reviewAfterFor(belief.halfLifeDays, confirmed ?? lastSeenAt),
    evidence,
    supersedes: [
      ...(current?.supersedes ?? []),
      ...superseded.map((card) => `${card.id}@${card.revision}`),
    ],
    conflicts: current?.conflicts ?? [],
  };
}

/**
 * A decaying belief becomes due for re-confirmation one half-life after the last
 * time the user backed it. Pinned beliefs (no half-life) never expire, so they
 * carry no review date. This is derived, not stored state, so it stays stable
 * across republished revisions of the same evidence.
 */
function reviewAfterFor(
  halfLifeDays: number | null,
  since: string | undefined,
): { reviewAfter?: string } {
  if (halfLifeDays === null || !Number.isFinite(halfLifeDays) || !since) return {};
  const base = Date.parse(since);
  if (!Number.isFinite(base)) return {};
  return {
    reviewAfter: new Date(base + halfLifeDays * 86_400_000).toISOString(),
  };
}

function cardsToBeliefs(
  cards: MemoryCard[],
  observations: UserObservation[],
  projectId: string,
): UserBelief[] {
  return cards.map((card) => {
    const scope = userScopeForCard(card, projectId);
    let evidence = observations.filter((item) =>
      item.logicalKey === card.logicalKey && sameScope(item.scope, scope));
    if (evidence.length === 0) {
      evidence = card.evidence
        .filter((item) => item.actor === "user")
        .map((item, index): UserObservation => ({
          id: `recovered_${card.id}_${item.eventHash.slice(0, 12)}_${index}`,
          actor: "user",
          signal: userSignal(item.signal),
          logicalKey: card.logicalKey,
          value: card.body,
          scope,
          polarity: "support",
          sessionId: item.sessionId,
          eventId: item.eventHash,
          eventSeq: item.eventSeq,
          eventHash: item.eventHash,
          observedAt: card.lastSeenAt,
        }));
    }
    return {
      id: card.id,
      logicalKey: card.logicalKey,
      value: card.body,
      scope,
      status: card.status,
      evidence,
      halfLifeDays: card.halfLifeDays,
      confidence: card.confidence,
      supportScore: card.supportScore,
      oppositionScore: card.oppositionScore,
      createdAt: card.createdAt,
      updatedAt: card.updatedAt,
    };
  });
}

function safeCurrentCards(paths: MemoryScopePaths): MemoryCard[] {
  try {
    return listCurrentCards(paths);
  } catch {
    // Invalid CURRENT is never bypassed by reading an older release.
    return [];
  }
}

function isAutoPublishable(
  operation: UserModelOperation,
  observation: UserObservation,
  risk: CandidateRisk,
  allowed: boolean,
): boolean {
  if (!allowed || risk !== "low" || !isExplicitSignal(observation.signal)) {
    return false;
  }
  if (
    operation.kind !== "ADD" &&
    operation.kind !== "REINFORCE" &&
    operation.kind !== "CONTEXTUALIZE" &&
    operation.kind !== "SUPERSEDE"
  ) {
    return false;
  }
  return operation.proposedBelief?.status === "active" ||
    operation.proposedBelief?.status === "confirmed";
}

function operationRisk(operation: UserModelOperation): CandidateRisk {
  const key = operation.logicalKey.toLocaleLowerCase();
  const value = operation.proposedBelief?.value.toLocaleLowerCase() ?? "";
  if (
    /(?:permission|credential|secret|security|skill|身份|健康|政治|宗教|财务|关系)/
      .test(`${key} ${value}`)
  ) {
    return "high";
  }
  if (
    key.startsWith("identity.") ||
    key.startsWith("goals.") ||
    key.startsWith("environment.")
  ) {
    return "medium";
  }
  return "low";
}

function memoryKind(belief: UserBelief): MemoryKind {
  if (belief.logicalKey.startsWith("communication.")) return "preference";
  if (belief.logicalKey.startsWith("workflow.")) return "workflow";
  if (belief.logicalKey.startsWith("architecture.")) return "decision";
  if (belief.logicalKey.startsWith("constraints.")) return "boundary";
  if (belief.logicalKey.startsWith("goals.")) return "goal";
  if (belief.logicalKey.startsWith("interests.")) return "interest";
  if (belief.logicalKey.startsWith("expertise.")) return "expertise";
  if (belief.logicalKey.startsWith("identity.")) return "identity";
  if (belief.evidence.every((item) =>
    item.signal === "habit" || item.signal === "inference")) return "habit";
  return "note";
}

function cardStatus(status: UserBelief["status"]): MemoryStatus {
  return status === "purged" ? "retired" : status;
}

function applicationFor(
  kind: MemoryKind,
  status: MemoryStatus,
): MemoryCard["application"] {
  if (
    kind === "identity" ||
    kind === "interest" ||
    kind === "note"
  ) {
    return "reference";
  }
  if (
    kind === "goal" ||
    kind === "expertise" ||
    status === "provisional"
  ) {
    return "advisory";
  }
  return status === "confirmed" || status === "active"
    ? "automatic"
    : "reference";
}

function scopeContexts(
  scope: UserMemoryScope,
  projectId: string,
): MemoryCard["contexts"] {
  return {
    domains: scope.kind === "domain" && scope.value ? [scope.value] : [],
    projects: scope.kind === "project" ? [scope.value ?? projectId] : [],
    surfaces: scope.kind === "surface" && scope.value ? [scope.value] : [],
    languages: [],
  };
}

function userScopeForCard(
  card: MemoryCard,
  projectId: string,
): UserMemoryScope {
  if (card.scope === "project") {
    return { kind: "project", value: card.contexts.projects[0] ?? projectId };
  }
  if (card.contexts.domains[0]) {
    return { kind: "domain", value: card.contexts.domains[0] };
  }
  if (card.contexts.surfaces[0]) {
    return { kind: "surface", value: card.contexts.surfaces[0] };
  }
  return { kind: "global" };
}

function conditionLabels(scope: UserMemoryScope): string[] {
  if (scope.kind === "global") return ["Apply across projects when relevant."];
  return [`Apply only in ${scope.kind}:${scope.value ?? ""}.`];
}

function aliasesFor(belief: UserBelief): string[] {
  return [...new Set([
    belief.logicalKey.replace(/[._/-]+/g, " "),
    belief.value.slice(0, 80),
  ].filter(Boolean))];
}

function tagsFor(belief: UserBelief): string[] {
  return [...new Set([
    ...belief.logicalKey.split(/[._/-]+/),
    belief.scope.kind,
  ].filter(Boolean))].slice(0, 20);
}

function titleForLogicalKey(logicalKey: string): string {
  return logicalKey
    .split(/[._/-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toLocaleUpperCase() + part.slice(1))
    .join(" ");
}

function safeCardId(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120);
  if (/^[a-zA-Z0-9]/.test(safe)) return safe;
  return `memory_${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}

function halfLifeFor(observation: UserObservation): number | null {
  const key = observation.logicalKey;
  if (key.startsWith("communication.")) return 180;
  if (key.startsWith("workflow.")) return 90;
  if (key.startsWith("goals.")) return 30;
  if (key.startsWith("interests.")) return 180;
  if (key.startsWith("expertise.")) return 365;
  if (observation.signal === "habit" || observation.signal === "inference") {
    return 30;
  }
  if (key.startsWith("identity.")) return null;
  return 90;
}

function confirmationSignal(signal: UserSignal): boolean {
  return signal === "approval" ||
    signal === "remember" ||
    signal === "correction";
}

function userSignal(value: string): UserSignal {
  const allowed: UserSignal[] = [
    "approval",
    "remember",
    "correction",
    "explicit_preference",
    "explicit_constraint",
    "explicit_goal",
    "choice",
    "habit",
    "inference",
    "other",
  ];
  return allowed.includes(value as UserSignal)
    ? value as UserSignal
    : "inference";
}

function earliestEvidenceTime(evidence: UserObservation[]): string | undefined {
  return evidence.map((item) => item.observedAt).sort()[0];
}

function latestEvidenceTime(evidence: UserObservation[]): string | undefined {
  return evidence.map((item) => item.observedAt).sort().at(-1);
}

function userAuthoredText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content.flatMap((block) => {
    if (
      block &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      return [(block as { text: string }).text];
    }
    return [];
  }).join("\n").trim();
}

function sessionIdFromRecord(
  records: ReadonlyArray<StoredSessionRecord>,
  record: StoredSessionRecord,
): string {
  for (const item of records) {
    if (item.type !== "session_meta") continue;
    const meta = item.data as { id?: unknown };
    if (typeof meta?.id === "string" && meta.id) return meta.id;
  }
  // A standalone event still has a stable provenance key; callers processing a
  // full session will normally supply session_meta.
  return `session_${record.event_id}`;
}
