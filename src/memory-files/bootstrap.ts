// Project bootstrap — turns deterministic repository facts into memory cards.
//
// This is the replacement for the old SQLite seeder, rebuilt on the file-memory
// invariants. Repository facts are a separate authority from user beliefs:
//
//   - They are written with authority "repository" and evidence actor
//     "repository", so card validation still refuses to let them masquerade as
//     something the user said.
//   - Their evidence hash is the hash of the scanned content itself, so a later
//     run can prove whether a card still matches the checkout.
//   - Bootstrap only ever touches cards it owns. User cards in the same release
//     are carried through untouched.
//   - Nothing is published when the scan matches the current release, so a warm
//     start costs one scan and zero writes.

import fs from "fs";
import path from "path";
import { FileMemoryRepository } from "./repository.js";
import { loadMemoryPolicy } from "./policy.js";
import {
  listCurrentCards,
  memoryPurgeFingerprint,
  publishMemoryRelease,
  readCurrentReleaseId,
  readPurgeState,
} from "./release.js";
import { validateMemoryCard } from "./card.js";
import { scanProjectFacts, type ProjectFact, type ProjectScanOptions } from "./project-scan.js";
import type {
  MemoryCard,
  MemoryChange,
  MemoryScopePaths,
  PurgeState,
} from "./types.js";

/** Marks cards this module owns; nothing else may write with this authority. */
export const REPOSITORY_AUTHORITY = "repository" as const;

export interface BootstrapProjectMemoryOptions extends ProjectScanOptions {
  workingDir: string;
  rootDir?: string;
  /** Master memory switch; false skips scanning entirely. */
  enabled?: boolean;
  /**
   * Paused learning also pauses repository facts. They are re-derivable, but a
   * user who paused learning did not ask for new memory writes.
   */
  learningEnabled?: boolean;
  now?: Date;
}

export interface BootstrapProjectMemoryResult {
  scanned: number;
  created: string[];
  revised: string[];
  retired: string[];
  unchanged: number;
  skipped: Array<{ logicalKey: string; reason: string }>;
  warnings: string[];
  releaseId?: string;
}

export async function bootstrapProjectMemory(
  options: BootstrapProjectMemoryOptions,
): Promise<BootstrapProjectMemoryResult> {
  const result: BootstrapProjectMemoryResult = {
    scanned: 0,
    created: [],
    revised: [],
    retired: [],
    unchanged: 0,
    skipped: [],
    warnings: [],
  };
  if (options.enabled === false) {
    result.warnings.push("memory_disabled");
    return result;
  }
  const policy = loadMemoryPolicy(options.rootDir);
  if (options.learningEnabled === false || !policy.learning_enabled) {
    result.warnings.push("memory_learning_paused");
    return result;
  }

  const repository = new FileMemoryRepository({
    rootDir: options.rootDir,
    projectDir: options.workingDir,
  });
  const paths = repository.projectPaths;
  const projectId = repository.projectId;
  const now = options.now ?? new Date();

  const scan = await scanProjectFacts(options.workingDir, options);
  result.scanned = scan.facts.length;
  result.warnings.push(...scan.warnings);

  const existing = safeCurrentRepositoryCards(paths);
  const purge = readPurgeState(paths);
  const changes: MemoryChange[] = [];

  for (const fact of scan.facts) {
    if (isPurged(fact, purge)) {
      result.skipped.push({
        logicalKey: fact.logicalKey,
        reason: "blocked_by_purge_ledger",
      });
      continue;
    }
    const current = existing.get(fact.logicalKey);
    if (current && repositoryContentHash(current) === fact.contentHash) {
      result.unchanged++;
      continue;
    }

    let card: MemoryCard;
    try {
      card = factToCard(fact, paths, projectId, now, current);
      validateMemoryCard(card);
    } catch (error) {
      // A single unsafe or malformed fact must not block the rest of the scan.
      result.skipped.push({
        logicalKey: fact.logicalKey,
        reason: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    if (current) {
      changes.push({
        type: "revise",
        card,
        expectedRevision: current.revision,
      });
      result.revised.push(fact.logicalKey);
    } else {
      changes.push({ type: "create", card });
      result.created.push(fact.logicalKey);
    }
  }

  const scannedKeys = new Set(scan.facts.map((fact) => fact.logicalKey));
  for (const [logicalKey, card] of existing) {
    if (scannedKeys.has(logicalKey)) continue;
    // The fact is no longer observable in the checkout, so the card must go.
    changes.push({
      type: "retire",
      logicalKey,
      expectedRevision: card.revision,
    });
    result.retired.push(logicalKey);
  }

  if (changes.length === 0) return result;

  try {
    const release = publishMemoryRelease(paths, {
      baseReleaseId: readCurrentReleaseId(paths),
      changes,
      createdAt: now.toISOString(),
      reason: `repository-bootstrap:${projectId.slice(0, 12)}`,
    });
    result.releaseId = release.id;
  } catch (error) {
    // Losing a CAS race or hitting a lock is normal with a concurrent CLI; the
    // next start re-scans and converges.
    result.warnings.push(
      `bootstrap_publish_failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    result.created = [];
    result.revised = [];
    result.retired = [];
  }
  return result;
}

/** Repository-authored cards from the current release, keyed by logical key. */
export function currentRepositoryCards(
  paths: MemoryScopePaths,
): Map<string, MemoryCard> {
  return safeCurrentRepositoryCards(paths);
}

export function isRepositoryCard(card: MemoryCard): boolean {
  return card.authority === REPOSITORY_AUTHORITY;
}

/**
 * Records whether the checkout still matches each bootstrapped card. This is
 * how `/memory stats` can report staleness without silently republishing.
 */
export async function auditProjectFacts(
  options: BootstrapProjectMemoryOptions,
): Promise<{
  stale: string[];
  missing: string[];
  orphaned: string[];
  matched: number;
}> {
  const repository = new FileMemoryRepository({
    rootDir: options.rootDir,
    projectDir: options.workingDir,
  });
  const existing = safeCurrentRepositoryCards(repository.projectPaths);
  const scan = await scanProjectFacts(options.workingDir, options);
  const stale: string[] = [];
  const missing: string[] = [];
  let matched = 0;

  for (const fact of scan.facts) {
    const card = existing.get(fact.logicalKey);
    if (!card) {
      missing.push(fact.logicalKey);
      continue;
    }
    if (repositoryContentHash(card) === fact.contentHash) matched++;
    else stale.push(fact.logicalKey);
  }

  const scannedKeys = new Set(scan.facts.map((fact) => fact.logicalKey));
  const orphaned = [...existing.keys()].filter((key) => !scannedKeys.has(key));
  return { stale, missing, orphaned, matched };
}

function safeCurrentRepositoryCards(
  paths: MemoryScopePaths,
): Map<string, MemoryCard> {
  const cards = new Map<string, MemoryCard>();
  try {
    for (const card of listCurrentCards(paths)) {
      if (isRepositoryCard(card)) cards.set(card.logicalKey, card);
    }
  } catch {
    // An unverifiable CURRENT is never bypassed by reading an older release.
    // Treating it as empty makes bootstrap fail closed: publishing will also
    // reject, and the next start retries.
  }
  return cards;
}

function repositoryContentHash(card: MemoryCard): string | null {
  const evidence = card.evidence.find((item) => item.actor === "repository");
  return evidence?.eventHash ?? null;
}

function isPurged(fact: ProjectFact, purge: PurgeState): boolean {
  return purge.logicalKeyFingerprints.has(
    memoryPurgeFingerprint("logical-key", fact.logicalKey),
  ) ||
    purge.idFingerprints.has(
      memoryPurgeFingerprint("id", repositoryCardId(fact.logicalKey)),
    );
}

function factToCard(
  fact: ProjectFact,
  paths: MemoryScopePaths,
  projectId: string,
  now: Date,
  current?: MemoryCard,
): MemoryCard {
  const timestamp = now.toISOString();
  // Git history moves far faster than layout, dependencies, or compiler config.
  const halfLifeDays = fact.source === "git_history" ? 14 : 90;
  return {
    schemaVersion: 1,
    id: current?.id ?? repositoryCardId(fact.logicalKey),
    revision: current ? current.revision + 1 : 1,
    logicalKey: fact.logicalKey,
    kind: fact.kind,
    scope: paths.scope,
    status: "active",
    origin: "derived",
    // Repository facts inform decisions; they are never standing user rules.
    application: "reference",
    authority: REPOSITORY_AUTHORITY,
    sensitivity: "normal",
    confidence: 0.9,
    supportScore: 1,
    oppositionScore: 0,
    halfLifeDays,
    title: fact.title,
    body: fact.body,
    conditions: [
      `Derived from ${fact.origin} in this checkout. Re-read the source before relying on it.`,
    ],
    exceptions: [
      "The working tree is authoritative. If it disagrees with this card, trust the working tree.",
    ],
    aliases: [fact.logicalKey.replace(/[._/-]+/g, " ")],
    tags: fact.tags,
    contexts: {
      domains: [],
      projects: [projectId],
      surfaces: [],
      languages: fact.languages,
    },
    createdAt: current?.createdAt ?? timestamp,
    updatedAt: timestamp,
    firstSeenAt: current?.firstSeenAt ?? timestamp,
    lastSeenAt: timestamp,
    lastConfirmedAt: timestamp,
    reviewAfter: new Date(now.getTime() + halfLifeDays * 86_400_000).toISOString(),
    evidence: [{
      sessionId: `repository:${projectId}`,
      eventSeq: 0,
      eventHash: fact.contentHash,
      actor: "repository",
      signal: `scan:${fact.source}`,
      excerpt: fact.origin,
    }],
    supersedes: current?.supersedes ?? [],
    conflicts: [],
  };
}

function repositoryCardId(logicalKey: string): string {
  const safe = logicalKey.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120);
  return /^[a-zA-Z0-9]/.test(safe) ? safe : `repo_${safe}`;
}

/**
 * True when a directory looks like a real project worth scanning. Bootstrapping
 * a home directory or a bare temp folder would produce noise, not facts.
 */
export function looksLikeProject(workingDir: string): boolean {
  const markers = [
    "package.json",
    "tsconfig.json",
    "pyproject.toml",
    "Cargo.toml",
    "go.mod",
    "requirements.txt",
    ".git",
  ];
  return markers.some((marker) => {
    try {
      return fs.existsSync(path.join(workingDir, marker));
    } catch {
      return false;
    }
  });
}
