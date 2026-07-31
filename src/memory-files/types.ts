export type MemoryScope = "global" | "project";

export type MemoryKind =
  | "preference"
  | "habit"
  | "boundary"
  | "identity"
  | "goal"
  | "interest"
  | "expertise"
  | "environment"
  | "decision"
  | "convention"
  | "lesson"
  | "workflow"
  | "open_loop"
  | "note";

export type MemoryStatus =
  | "confirmed"
  | "active"
  | "provisional"
  | "tentative"
  | "candidate"
  | "conflicted"
  | "superseded"
  | "retired";

export type MemoryOrigin = "explicit" | "inferred" | "derived" | "migrated";

export type MemoryApplication = "automatic" | "advisory" | "reference";

export type MemoryAuthority =
  | "user_explicit"
  | "user_inferred"
  | "repository"
  | "observed_outcome"
  | "agent_derived";

export type MemorySensitivity = "normal" | "personal" | "sensitive" | "secret";

export interface MemoryContexts {
  domains: string[];
  projects: string[];
  surfaces: string[];
  languages: string[];
}

export interface MemoryEvidence {
  sessionId: string;
  eventSeq: number;
  eventHash: string;
  actor: "user" | "tool" | "repository" | "assistant" | "migration";
  signal: string;
  excerpt?: string;
}

export interface MemoryCard {
  schemaVersion: 1;
  id: string;
  revision: number;
  logicalKey: string;
  kind: MemoryKind;
  scope: MemoryScope;
  status: MemoryStatus;
  origin: MemoryOrigin;
  application: MemoryApplication;
  authority: MemoryAuthority;
  sensitivity: MemorySensitivity;
  confidence: number;
  supportScore: number;
  oppositionScore: number;
  halfLifeDays: number | null;
  title: string;
  body: string;
  conditions: string[];
  exceptions: string[];
  aliases: string[];
  tags: string[];
  contexts: MemoryContexts;
  createdAt: string;
  updatedAt: string;
  firstSeenAt: string;
  lastSeenAt: string;
  lastConfirmedAt?: string;
  reviewAfter?: string;
  evidence: MemoryEvidence[];
  supersedes: string[];
  conflicts: string[];
}

export interface CatalogEntry {
  id: string;
  revision: number;
  logicalKey: string;
  kind: MemoryKind;
  scope: MemoryScope;
  status: MemoryStatus;
  application: MemoryApplication;
  authority: MemoryAuthority;
  sensitivity: MemorySensitivity;
  confidence: number;
  supportScore: number;
  oppositionScore: number;
  halfLifeDays: number | null;
  title: string;
  summary: string;
  aliases: string[];
  tags: string[];
  contexts: MemoryContexts;
  firstSeenAt: string;
  lastSeenAt: string;
  path: string;
}

export interface MemoryScopePaths {
  rootDir: string;
  memoryDir: string;
  scopeDir: string;
  currentPath: string;
  releasesDir: string;
  stagingDir: string;
  lockPath: string;
  purgeLedgerPath: string;
  scope: MemoryScope;
  projectId?: string;
}

export interface MemoryChangeBase {
  expectedRevision?: number;
}

export interface MemoryCardChange extends MemoryChangeBase {
  type: "create" | "revise" | "supersede";
  card: MemoryCard;
}

export interface MemoryRetireChange extends MemoryChangeBase {
  type: "retire";
  logicalKey: string;
}

export type MemoryChange = MemoryCardChange | MemoryRetireChange;

export interface MemoryChangeSummary {
  type: MemoryChange["type"] | "rollback" | "purge";
  logicalKey?: string;
  cardId?: string;
  revision?: number;
  fingerprint?: string;
}

export interface ReleaseManifest {
  schemaVersion: 1;
  releaseId: string;
  parentReleaseId: string | null;
  rollbackOf?: string;
  scope: MemoryScope;
  projectId?: string;
  createdAt: string;
  reason?: string;
  purgeEpoch: number;
  changes: MemoryChangeSummary[];
  fileHashes: Record<string, string>;
}

export interface MemoryReleaseSnapshot {
  id: string;
  dir: string;
  manifest: ReleaseManifest;
  cards: MemoryCard[];
  catalog: CatalogEntry[];
  profile: string;
  index: string;
}

export interface PublishMemoryReleaseInput {
  baseReleaseId: string | null;
  changes: MemoryChange[];
  releaseId?: string;
  createdAt?: string;
  reason?: string;
}

export interface RollbackMemoryReleaseInput {
  baseReleaseId: string | null;
  targetReleaseId: string;
  releaseId?: string;
  createdAt?: string;
  reason?: string;
}

export interface PurgeMemoriesInput {
  baseReleaseId: string | null;
  ids?: string[];
  logicalKeys?: string[];
  values?: string[];
  sessionIds?: string[];
  releaseId?: string;
  createdAt?: string;
  reason?: string;
}

export interface PurgeLedgerRecord {
  schemaVersion: 1;
  purgeId: string;
  epoch: number;
  scope: MemoryScope;
  projectId?: string;
  idFingerprints: string[];
  logicalKeyFingerprints: string[];
  valueFingerprints: string[];
  valueFingerprintLengths: number[];
  sessionIdFingerprints: string[];
  createdAt: string;
}

export interface PurgeState {
  epoch: number;
  idFingerprints: Set<string>;
  logicalKeyFingerprints: Set<string>;
  valueFingerprints: Set<string>;
  valueFingerprintLengths: Set<number>;
  sessionIdFingerprints: Set<string>;
}

export interface ReleaseVerification {
  valid: boolean;
  errors: string[];
  manifest?: ReleaseManifest;
}
