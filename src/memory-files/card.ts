import YAML from "yaml";
import { findMemorySafetyIssues } from "./policy.js";
import type {
  MemoryApplication,
  MemoryAuthority,
  MemoryCard,
  MemoryContexts,
  MemoryEvidence,
  MemoryKind,
  MemoryOrigin,
  MemoryScope,
  MemorySensitivity,
  MemoryStatus,
} from "./types.js";

const CARD_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const LOGICAL_KEY_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,191}$/;

const KINDS = new Set<MemoryKind>([
  "preference", "habit", "boundary", "identity", "goal", "interest",
  "expertise", "environment", "decision", "convention", "lesson", "workflow",
  "open_loop", "note",
]);
const SCOPES = new Set<MemoryScope>(["global", "project"]);
const STATUSES = new Set<MemoryStatus>([
  "confirmed", "active", "provisional", "tentative", "candidate",
  "conflicted", "superseded", "retired",
]);
const ORIGINS = new Set<MemoryOrigin>([
  "explicit", "inferred", "derived", "migrated",
]);
const APPLICATIONS = new Set<MemoryApplication>([
  "automatic", "advisory", "reference",
]);
const AUTHORITIES = new Set<MemoryAuthority>([
  "user_explicit", "user_inferred", "repository", "observed_outcome",
  "agent_derived",
]);
const SENSITIVITIES = new Set<MemorySensitivity>([
  "normal", "personal", "sensitive", "secret",
]);

export function memoryCardRef(card: Pick<MemoryCard, "id" | "revision">): string {
  return `${card.id}@${card.revision}`;
}

export function serializeMemoryCard(card: MemoryCard): string {
  validateMemoryCard(card);
  const frontmatter = {
    schema_version: card.schemaVersion,
    id: card.id,
    revision: card.revision,
    logical_key: card.logicalKey,
    kind: card.kind,
    scope: card.scope,
    status: card.status,
    origin: card.origin,
    application: card.application,
    authority: card.authority,
    sensitivity: card.sensitivity,
    confidence: card.confidence,
    support_score: card.supportScore,
    opposition_score: card.oppositionScore,
    half_life_days: card.halfLifeDays,
    title: card.title,
    conditions: card.conditions,
    exceptions: card.exceptions,
    aliases: card.aliases,
    tags: card.tags,
    contexts: card.contexts,
    created_at: card.createdAt,
    updated_at: card.updatedAt,
    first_seen_at: card.firstSeenAt,
    last_seen_at: card.lastSeenAt,
    ...(card.lastConfirmedAt
      ? { last_confirmed_at: card.lastConfirmedAt }
      : {}),
    ...(card.reviewAfter ? { review_after: card.reviewAfter } : {}),
    evidence: card.evidence.map((item) => ({
      session_id: item.sessionId,
      event_seq: item.eventSeq,
      event_hash: item.eventHash,
      actor: item.actor,
      signal: item.signal,
      ...(item.excerpt ? { excerpt: item.excerpt } : {}),
    })),
    supersedes: card.supersedes,
    conflicts: card.conflicts,
  };
  const yaml = YAML.stringify(frontmatter, { lineWidth: 0 }).trimEnd();
  return `---\n${yaml}\n---\n\n${card.body.trim()}\n`;
}

export function parseMemoryCard(markdown: string): MemoryCard {
  const match = markdown.match(
    /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/,
  );
  if (!match) {
    throw new Error("Memory card must contain YAML frontmatter.");
  }

  const raw = YAML.parse(match[1]) as unknown;
  if (!isRecord(raw)) {
    throw new Error("Memory card frontmatter must be a YAML mapping.");
  }

  const contexts = parseContexts(raw.contexts);
  const evidence = parseEvidence(raw.evidence);
  const nowFallback = requiredString(raw.updated_at ?? raw.created_at, "updated_at");
  const card: MemoryCard = {
    schemaVersion: requiredNumber(raw.schema_version, "schema_version") as 1,
    id: requiredString(raw.id, "id"),
    revision: requiredNumber(raw.revision, "revision"),
    logicalKey: requiredString(raw.logical_key, "logical_key"),
    kind: requiredString(raw.kind, "kind") as MemoryKind,
    scope: requiredString(raw.scope, "scope") as MemoryScope,
    status: optionalString(raw.status, "active") as MemoryStatus,
    origin: optionalString(raw.origin, "derived") as MemoryOrigin,
    application: optionalString(raw.application, "advisory") as MemoryApplication,
    authority: optionalString(raw.authority, "agent_derived") as MemoryAuthority,
    sensitivity: optionalString(raw.sensitivity, "normal") as MemorySensitivity,
    confidence: optionalNumber(raw.confidence, 0.5),
    supportScore: optionalNumber(raw.support_score, 0),
    oppositionScore: optionalNumber(raw.opposition_score, 0),
    halfLifeDays: nullableNumber(raw.half_life_days),
    title: requiredString(raw.title, "title"),
    body: match[2].trim(),
    conditions: stringArray(raw.conditions),
    exceptions: stringArray(raw.exceptions),
    aliases: stringArray(raw.aliases),
    tags: stringArray(raw.tags),
    contexts,
    createdAt: requiredString(raw.created_at, "created_at"),
    updatedAt: nowFallback,
    firstSeenAt: optionalString(raw.first_seen_at, nowFallback),
    lastSeenAt: optionalString(raw.last_seen_at, nowFallback),
    lastConfirmedAt: optionalMaybeString(raw.last_confirmed_at),
    reviewAfter: optionalMaybeString(raw.review_after),
    evidence,
    supersedes: stringArray(raw.supersedes),
    conflicts: stringArray(raw.conflicts),
  };
  validateMemoryCard(card);
  return card;
}

export function validateMemoryCard(card: MemoryCard): void {
  if (card.schemaVersion !== 1) throw new Error("Unsupported memory card schema.");
  if (!CARD_ID_PATTERN.test(card.id)) throw new Error(`Unsafe memory card id: ${card.id}`);
  if (
    !LOGICAL_KEY_PATTERN.test(card.logicalKey) ||
    card.logicalKey.split("/").includes("..")
  ) {
    throw new Error(`Unsafe memory logical key: ${card.logicalKey}`);
  }
  if (!Number.isInteger(card.revision) || card.revision < 1) {
    throw new Error("Memory revision must be a positive integer.");
  }
  if (!KINDS.has(card.kind)) throw new Error(`Invalid memory kind: ${card.kind}`);
  if (!SCOPES.has(card.scope)) throw new Error(`Invalid memory scope: ${card.scope}`);
  if (!STATUSES.has(card.status)) throw new Error(`Invalid memory status: ${card.status}`);
  if (!ORIGINS.has(card.origin)) throw new Error(`Invalid memory origin: ${card.origin}`);
  if (!APPLICATIONS.has(card.application)) {
    throw new Error(`Invalid memory application: ${card.application}`);
  }
  if (!AUTHORITIES.has(card.authority)) {
    throw new Error(`Invalid memory authority: ${card.authority}`);
  }
  if (!SENSITIVITIES.has(card.sensitivity)) {
    throw new Error(`Invalid memory sensitivity: ${card.sensitivity}`);
  }
  if (card.sensitivity === "secret") {
    throw new Error("Secrets must never be persisted as memory cards.");
  }
  validateFiniteRange(card.confidence, 0, 1, "confidence");
  validateNonNegative(card.supportScore, "supportScore");
  validateNonNegative(card.oppositionScore, "oppositionScore");
  if (
    card.halfLifeDays !== null &&
    (!Number.isFinite(card.halfLifeDays) || card.halfLifeDays <= 0)
  ) {
    throw new Error("halfLifeDays must be null or a positive number.");
  }
  if (!card.title.trim()) throw new Error("Memory title cannot be empty.");
  validateTimestamp(card.createdAt, "createdAt");
  validateTimestamp(card.updatedAt, "updatedAt");
  validateTimestamp(card.firstSeenAt, "firstSeenAt");
  validateTimestamp(card.lastSeenAt, "lastSeenAt");
  if (card.lastConfirmedAt) validateTimestamp(card.lastConfirmedAt, "lastConfirmedAt");
  if (card.reviewAfter) validateTimestamp(card.reviewAfter, "reviewAfter");
  validateStringArray(card.conditions, "conditions");
  validateStringArray(card.exceptions, "exceptions");
  validateStringArray(card.aliases, "aliases");
  validateStringArray(card.tags, "tags");
  validateStringArray(card.supersedes, "supersedes");
  validateStringArray(card.conflicts, "conflicts");
  validateContexts(card.contexts);
  for (const item of card.evidence) validateEvidence(item);

  if (
    (card.authority === "user_explicit" ||
      card.authority === "user_inferred")
  ) {
    if (card.evidence.length === 0) {
      throw new Error("User memory requires traceable user-authored evidence.");
    }
    if (card.evidence.some((item) => item.actor !== "user")) {
      throw new Error(
        "Assistant, tool, repository, and migration events cannot support a user belief.",
      );
    }
  }

  const safetyText = JSON.stringify({
    logicalKey: card.logicalKey,
    title: card.title,
    body: card.body,
    conditions: card.conditions,
    exceptions: card.exceptions,
    aliases: card.aliases,
    tags: card.tags,
    evidenceExcerpts: card.evidence.map((item) => item.excerpt ?? ""),
  });
  const safetyIssues = findMemorySafetyIssues(safetyText);
  if (safetyIssues.length > 0) {
    throw new Error(
      `Unsafe memory card content: ${safetyIssues.join(", ")}.`,
    );
  }
}

function parseContexts(value: unknown): MemoryContexts {
  if (!isRecord(value)) {
    return { domains: [], projects: [], surfaces: [], languages: [] };
  }
  return {
    domains: stringArray(value.domains),
    projects: stringArray(value.projects),
    surfaces: stringArray(value.surfaces),
    languages: stringArray(value.languages),
  };
}

function parseEvidence(value: unknown): MemoryEvidence[] {
  if (!Array.isArray(value)) return [];
  return value.map((item, index) => {
    if (!isRecord(item)) throw new Error(`evidence[${index}] must be a mapping.`);
    return {
      sessionId: requiredString(item.session_id, `evidence[${index}].session_id`),
      eventSeq: requiredNumber(item.event_seq, `evidence[${index}].event_seq`),
      eventHash: requiredString(item.event_hash, `evidence[${index}].event_hash`),
      actor: requiredString(item.actor, `evidence[${index}].actor`) as MemoryEvidence["actor"],
      signal: requiredString(item.signal, `evidence[${index}].signal`),
      excerpt: optionalMaybeString(item.excerpt),
    };
  });
}

function validateEvidence(item: MemoryEvidence): void {
  if (!item.sessionId.trim()) throw new Error("Evidence sessionId cannot be empty.");
  if (!Number.isInteger(item.eventSeq) || item.eventSeq < 0) {
    throw new Error("Evidence eventSeq must be a non-negative integer.");
  }
  if (!item.eventHash.trim()) throw new Error("Evidence eventHash cannot be empty.");
  if (!["user", "tool", "repository", "assistant", "migration"].includes(item.actor)) {
    throw new Error(`Invalid evidence actor: ${item.actor}`);
  }
  if (!item.signal.trim()) throw new Error("Evidence signal cannot be empty.");
}

function validateContexts(contexts: MemoryContexts): void {
  validateStringArray(contexts.domains, "contexts.domains");
  validateStringArray(contexts.projects, "contexts.projects");
  validateStringArray(contexts.surfaces, "contexts.surfaces");
  validateStringArray(contexts.languages, "contexts.languages");
}

function validateStringArray(value: string[], field: string): void {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${field} must be an array of strings.`);
  }
}

function validateTimestamp(value: string, field: string): void {
  if (!value.trim() || Number.isNaN(Date.parse(value))) {
    throw new Error(`${field} must be an ISO-compatible timestamp.`);
  }
}

function validateFiniteRange(
  value: number,
  min: number,
  max: number,
  field: string,
): void {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${field} must be between ${min} and ${max}.`);
  }
}

function validateNonNegative(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a non-negative number.`);
  }
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return value;
}

function optionalString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function optionalMaybeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function requiredNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${field} must be a number.`);
  }
  return value;
}

function optionalNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
