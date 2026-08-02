import { createHash, randomUUID } from "crypto";
import fs from "fs";
import path from "path";
import {
  buildCatalog,
  buildMemoryIndex,
  buildUserProfile,
  parseCatalog,
  searchCatalog,
  serializeCatalog,
  type CatalogSearchOptions,
} from "./catalog.js";
import {
  memoryCardRef,
  parseMemoryCard,
  serializeMemoryCard,
  validateMemoryCard,
} from "./card.js";
import { ensureMemoryScopeDirectories } from "./paths.js";
import type {
  CatalogEntry,
  MemoryCard,
  MemoryChange,
  MemoryChangeSummary,
  MemoryReleaseSnapshot,
  MemoryScopePaths,
  PublishMemoryReleaseInput,
  PurgeLedgerRecord,
  PurgeMemoriesInput,
  PurgeState,
  ReleaseManifest,
  ReleaseVerification,
  RollbackMemoryReleaseInput,
} from "./types.js";

const RELEASE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const MANIFEST_FILE = "manifest.json";
const MANIFEST_HASH_FILE = "manifest.sha256";
const LOCK_STALE_AFTER_MS = 5 * 60_000;

export class MemoryCasError extends Error {
  constructor(expected: string | null, actual: string | null) {
    super(
      `Memory CURRENT changed: expected ${expected ?? "<none>"}, ` +
      `found ${actual ?? "<none>"}.`,
    );
    this.name = "MemoryCasError";
  }
}

export class MemoryScopeLockedError extends Error {
  constructor(lockPath: string) {
    super(`Memory scope is locked by another publisher: ${lockPath}`);
    this.name = "MemoryScopeLockedError";
  }
}

export function readCurrentReleaseId(paths: MemoryScopePaths): string | null {
  if (!fs.existsSync(paths.currentPath)) return null;
  const releaseId = fs.readFileSync(paths.currentPath, "utf8").trim();
  if (!releaseId) return null;
  assertSafeReleaseId(releaseId);
  return releaseId;
}

export function readCurrentRelease(
  paths: MemoryScopePaths,
): MemoryReleaseSnapshot | null {
  const releaseId = readCurrentReleaseId(paths);
  return releaseId ? readMemoryRelease(paths, releaseId) : null;
}

export function readMemoryRelease(
  paths: MemoryScopePaths,
  releaseId: string,
): MemoryReleaseSnapshot {
  assertSafeReleaseId(releaseId);
  const verification = verifyRelease(paths, releaseId);
  if (!verification.valid || !verification.manifest) {
    throw new Error(
      `Invalid memory release ${releaseId}: ${verification.errors.join("; ")}`,
    );
  }

  const releaseDir = path.join(paths.releasesDir, releaseId);
  const manifest = verification.manifest;
  const cards = Object.keys(manifest.fileHashes)
    .filter((relativePath) =>
      relativePath.startsWith("cards/") && relativePath.endsWith(".md"))
    .sort()
    .map((relativePath) =>
      parseMemoryCard(fs.readFileSync(path.join(releaseDir, relativePath), "utf8")));
  const catalogText = fs.readFileSync(path.join(releaseDir, "catalog.tsv"), "utf8");
  const purge = readPurgeState(paths);
  const visibleCards = filterPurgedCards(cards, purge);
  const purgeOverlayRequired = manifest.purgeEpoch < purge.epoch;
  const visibleIds = new Set(visibleCards.map((card) => card.id));
  const catalog = purgeOverlayRequired
    ? buildCatalog(visibleCards)
    : parseCatalog(catalogText).filter((entry) => visibleIds.has(entry.id));

  return {
    id: releaseId,
    dir: releaseDir,
    manifest,
    cards: visibleCards,
    catalog,
    profile: purgeOverlayRequired
      ? buildUserProfile(visibleCards)
      : fs.readFileSync(path.join(releaseDir, "PROFILE.md"), "utf8"),
    index: purgeOverlayRequired
      ? buildMemoryIndex(visibleCards)
      : fs.readFileSync(path.join(releaseDir, "INDEX.md"), "utf8"),
  };
}

export function listCurrentCards(paths: MemoryScopePaths): MemoryCard[] {
  return readCurrentRelease(paths)?.cards ?? [];
}

export function searchCurrentCatalog(
  paths: MemoryScopePaths,
  query: string,
  options: number | CatalogSearchOptions = {},
): CatalogEntry[] {
  return searchCatalog(readCurrentRelease(paths)?.catalog ?? [], query, options);
}

export function publishMemoryRelease(
  paths: MemoryScopePaths,
  input: PublishMemoryReleaseInput,
): MemoryReleaseSnapshot {
  return withMemoryScopeLock(paths, () => {
    assertCurrent(paths, input.baseReleaseId);
    const parent = input.baseReleaseId
      ? readMemoryRelease(paths, input.baseReleaseId)
      : null;
    const cards = applyMemoryChanges(
      parent?.cards ?? [],
      input.changes,
      paths,
    );
    const purge = readPurgeState(paths);
    const filtered = filterPurgedCards(cards, purge);
    return createRelease(paths, {
      cards: filtered,
      parentReleaseId: input.baseReleaseId,
      releaseId: input.releaseId,
      createdAt: input.createdAt,
      reason: input.reason,
      purgeEpoch: purge.epoch,
      changes: summarizeChanges(input.changes),
    });
  });
}

export function rollbackMemoryRelease(
  paths: MemoryScopePaths,
  input: RollbackMemoryReleaseInput,
): MemoryReleaseSnapshot {
  return withMemoryScopeLock(paths, () => {
    assertCurrent(paths, input.baseReleaseId);
    const target = readMemoryRelease(paths, input.targetReleaseId);
    const purge = readPurgeState(paths);
    return createRelease(paths, {
      cards: filterPurgedCards(target.cards, purge),
      parentReleaseId: input.baseReleaseId,
      rollbackOf: input.targetReleaseId,
      releaseId: input.releaseId,
      createdAt: input.createdAt,
      reason: input.reason ?? `Rollback to ${input.targetReleaseId}`,
      purgeEpoch: purge.epoch,
      changes: [{ type: "rollback" }],
    });
  });
}

/**
 * Apply a purge while the caller already owns this scope's publication lock.
 * The hard-purge orchestrator keeps the fail-closed ledger, new release, and
 * physical cleanup under the same lock.
 */
export function purgeMemoriesWithinLock(
  paths: MemoryScopePaths,
  input: PurgeMemoriesInput,
): MemoryReleaseSnapshot {
  assertCurrent(paths, input.baseReleaseId);
  const ids = sortedUnique(input.ids ?? []);
  const logicalKeys = sortedUnique(input.logicalKeys ?? []);
  const values = sortedUnique(
    (input.values ?? []).map(normalizePurgeValue),
  );
  const sessionIds = sortedUnique(input.sessionIds ?? []);
  if (
    ids.length === 0 &&
    logicalKeys.length === 0 &&
    values.length === 0 &&
    sessionIds.length === 0
  ) {
    throw new Error(
      "A purge requires at least one memory id, logical key, value, or session.",
    );
  }

  // Validate everything readable before the fail-closed ledger append. If a
  // later filesystem failure occurs the ledger deliberately remains durable,
  // but ordinary bad input must not create a partial purge.
  const current = input.baseReleaseId
    ? readMemoryRelease(paths, input.baseReleaseId)
    : null;
  if (input.releaseId) {
    assertSafeReleaseId(input.releaseId);
    if (fs.existsSync(path.join(paths.releasesDir, input.releaseId))) {
      throw new Error(`Memory release already exists: ${input.releaseId}`);
    }
  }
  const before = readPurgeState(paths);
  const createdAt = input.createdAt ?? new Date().toISOString();
  const record: PurgeLedgerRecord = {
    schemaVersion: 1,
    purgeId: `purge_${randomUUID()}`,
    epoch: before.epoch + 1,
    scope: paths.scope,
    ...(paths.projectId ? { projectId: paths.projectId } : {}),
    idFingerprints: ids.map((id) => memoryPurgeFingerprint("id", id)),
    logicalKeyFingerprints: logicalKeys.map((logicalKey) =>
      memoryPurgeFingerprint("logical-key", logicalKey)),
    valueFingerprints: values.map((value) =>
      memoryPurgeFingerprint("value", value)),
    valueFingerprintLengths: sortedUniqueNumbers(
      values.map((value) => value.length),
    ),
    sessionIdFingerprints: sessionIds.map((sessionId) =>
      memoryPurgeFingerprint("session-id", sessionId)),
    createdAt,
  };
  appendPurgeRecord(paths, record);

  const purge = readPurgeState(paths);
  return createRelease(paths, {
    cards: filterPurgedCards(current?.cards ?? [], purge),
    parentReleaseId: input.baseReleaseId,
    releaseId: input.releaseId,
    createdAt,
    reason: "Privacy purge",
    purgeEpoch: purge.epoch,
    changes: [
      ...ids.map((id) => ({
        type: "purge" as const,
        fingerprint: memoryPurgeFingerprint("id", id),
      })),
      ...logicalKeys.map((logicalKey) => ({
        type: "purge" as const,
        fingerprint: memoryPurgeFingerprint("logical-key", logicalKey),
      })),
      ...values.map((value) => ({
        type: "purge" as const,
        fingerprint: memoryPurgeFingerprint("value", value),
      })),
      ...sessionIds.map((sessionId) => ({
        type: "purge" as const,
        fingerprint: memoryPurgeFingerprint("session-id", sessionId),
      })),
    ],
  });
}

export function readPurgeState(paths: MemoryScopePaths): PurgeState {
  const state: PurgeState = {
    epoch: 0,
    idFingerprints: new Set<string>(),
    logicalKeyFingerprints: new Set<string>(),
    valueFingerprints: new Set<string>(),
    valueFingerprintLengths: new Set<number>(),
    sessionIdFingerprints: new Set<string>(),
  };
  if (!fs.existsSync(paths.purgeLedgerPath)) return state;

  const lines = fs.readFileSync(paths.purgeLedgerPath, "utf8").split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      throw new Error(`Malformed purge ledger record on line ${index + 1}.`);
    }
    const record = parsePurgeRecord(raw, index + 1);
    if (
      record.scope !== paths.scope ||
      (record.scope === "project" && record.projectId !== paths.projectId)
    ) {
      continue;
    }
    state.epoch = Math.max(state.epoch, record.epoch);
    record.idFingerprints.forEach((fingerprint) =>
      state.idFingerprints.add(fingerprint));
    record.logicalKeyFingerprints.forEach((fingerprint) =>
      state.logicalKeyFingerprints.add(fingerprint));
    record.valueFingerprints.forEach((fingerprint) =>
      state.valueFingerprints.add(fingerprint));
    record.valueFingerprintLengths.forEach((length) =>
      state.valueFingerprintLengths.add(length));
    record.sessionIdFingerprints.forEach((fingerprint) =>
      state.sessionIdFingerprints.add(fingerprint));
  }
  return state;
}

/**
 * Durable fail-closed check for a live SessionStore. Global tombstones apply
 * everywhere; project tombstones apply only to the matching project id.
 */
export function isMemorySessionPurged(
  rootDir: string,
  sessionId: string,
  projectId?: string,
): boolean {
  const ledgerPath = path.join(path.resolve(rootDir), "memory", "purge-ledger.jsonl");
  if (!fs.existsSync(ledgerPath)) return false;
  const fingerprint = memoryPurgeFingerprint("session-id", sessionId);
  const lines = fs.readFileSync(ledgerPath, "utf8").split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      throw new Error(`Malformed purge ledger record on line ${index + 1}.`);
    }
    const record = parsePurgeRecord(raw, index + 1);
    if (!record.sessionIdFingerprints.includes(fingerprint)) continue;
    if (record.scope === "global" || record.projectId === projectId) return true;
  }
  return false;
}

export function verifyRelease(
  paths: MemoryScopePaths,
  releaseId: string,
): ReleaseVerification {
  const errors: string[] = [];
  try {
    assertSafeReleaseId(releaseId);
  } catch (error) {
    return {
      valid: false,
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }

  const releaseDir = path.join(paths.releasesDir, releaseId);
  const manifestPath = path.join(releaseDir, MANIFEST_FILE);
  const manifestHashPath = path.join(releaseDir, MANIFEST_HASH_FILE);
  if (!fs.existsSync(manifestPath) || !fs.existsSync(manifestHashPath)) {
    return {
      valid: false,
      errors: [`Release ${releaseId} is missing its manifest or manifest hash.`],
    };
  }

  let manifest: ReleaseManifest | undefined;
  try {
    const manifestText = fs.readFileSync(manifestPath, "utf8");
    const expectedManifestHash = fs.readFileSync(manifestHashPath, "utf8").trim();
    const actualManifestHash = sha256(manifestText);
    if (expectedManifestHash !== actualManifestHash) {
      errors.push("manifest.sha256 does not match manifest.json.");
    }
    manifest = parseManifest(JSON.parse(manifestText) as unknown);
    if (manifest.releaseId !== releaseId) errors.push("Manifest releaseId mismatch.");
    if (manifest.scope !== paths.scope) errors.push("Manifest scope mismatch.");
    if (
      manifest.scope === "project" &&
      manifest.projectId !== paths.projectId
    ) {
      errors.push("Manifest projectId mismatch.");
    }

    const expectedFiles = new Set([
      MANIFEST_FILE,
      MANIFEST_HASH_FILE,
      ...Object.keys(manifest.fileHashes),
    ]);
    for (const [relativePath, expectedHash] of Object.entries(
      manifest.fileHashes,
    )) {
      if (!isSafeRelativePath(relativePath)) {
        errors.push(`Unsafe manifest path: ${relativePath}`);
        continue;
      }
      const filePath = path.join(releaseDir, relativePath);
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        errors.push(`Missing release file: ${relativePath}`);
        continue;
      }
      if (sha256(fs.readFileSync(filePath)) !== expectedHash) {
        errors.push(`Hash mismatch: ${relativePath}`);
      }
    }
    for (const relativePath of listFilesSafely(releaseDir, errors)) {
      if (!expectedFiles.has(relativePath)) {
        errors.push(`Unexpected release file: ${relativePath}`);
      }
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  return { valid: errors.length === 0, errors, manifest };
}

interface CreateReleaseOptions {
  cards: MemoryCard[];
  parentReleaseId: string | null;
  rollbackOf?: string;
  releaseId?: string;
  createdAt?: string;
  reason?: string;
  purgeEpoch: number;
  changes: MemoryChangeSummary[];
}

function createRelease(
  paths: MemoryScopePaths,
  options: CreateReleaseOptions,
): MemoryReleaseSnapshot {
  ensureMemoryScopeDirectories(paths);
  const releaseId = options.releaseId ?? generateReleaseId();
  assertSafeReleaseId(releaseId);
  const releaseDir = path.join(paths.releasesDir, releaseId);
  if (fs.existsSync(releaseDir)) {
    throw new Error(`Memory release already exists: ${releaseId}`);
  }

  const stagingDir = path.join(
    paths.stagingDir,
    `${releaseId}.${randomUUID().slice(0, 8)}`,
  );
  fs.mkdirSync(path.join(stagingDir, "cards"), { recursive: true });

  try {
    const cards = [...options.cards].sort(compareCards);
    validateReleaseCards(cards, paths);
    for (const card of cards) {
      fs.writeFileSync(
        path.join(stagingDir, "cards", `${card.id}.md`),
        serializeMemoryCard(card),
        "utf8",
      );
    }

    const catalog = buildCatalog(cards);
    fs.writeFileSync(
      path.join(stagingDir, "catalog.tsv"),
      serializeCatalog(catalog),
      "utf8",
    );
    fs.writeFileSync(
      path.join(stagingDir, "INDEX.md"),
      buildMemoryIndex(cards),
      "utf8",
    );
    fs.writeFileSync(
      path.join(stagingDir, "PROFILE.md"),
      buildUserProfile(cards),
      "utf8",
    );

    const fileHashes = buildFileHashes(stagingDir);
    const manifest: ReleaseManifest = {
      schemaVersion: 1,
      releaseId,
      parentReleaseId: options.parentReleaseId,
      ...(options.rollbackOf ? { rollbackOf: options.rollbackOf } : {}),
      scope: paths.scope,
      ...(paths.projectId ? { projectId: paths.projectId } : {}),
      createdAt: options.createdAt ?? new Date().toISOString(),
      ...(options.reason ? { reason: options.reason } : {}),
      purgeEpoch: options.purgeEpoch,
      changes: options.changes,
      fileHashes,
    };
    const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
    fs.writeFileSync(path.join(stagingDir, MANIFEST_FILE), manifestText, "utf8");
    fs.writeFileSync(
      path.join(stagingDir, MANIFEST_HASH_FILE),
      `${sha256(manifestText)}\n`,
      "utf8",
    );

    // A non-cooperating process may have changed CURRENT despite our lock.
    // Re-check immediately before making the staged snapshot visible.
    assertCurrent(paths, options.parentReleaseId);
    fs.renameSync(stagingDir, releaseDir);
    makeReleaseReadOnly(releaseDir);
    writeCurrentAtomically(paths, releaseId);
    return readMemoryRelease(paths, releaseId);
  } catch (error) {
    fs.rmSync(stagingDir, { recursive: true, force: true });
    throw error;
  }
}

function applyMemoryChanges(
  baseCards: MemoryCard[],
  changes: MemoryChange[],
  paths: MemoryScopePaths,
): MemoryCard[] {
  const cards = new Map(baseCards.map((card) => [card.id, cloneCard(card)]));
  const purge = readPurgeState(paths);

  for (const change of changes) {
    if (change.type === "retire") {
      const targets = [...cards.values()]
        .filter((card) => card.logicalKey === change.logicalKey);
      if (targets.length === 0) {
        throw new Error(`Cannot retire missing memory: ${change.logicalKey}`);
      }
      if (
        change.expectedRevision !== undefined &&
        targets.some((card) => card.revision !== change.expectedRevision)
      ) {
        throw new Error(`Revision mismatch while retiring ${change.logicalKey}.`);
      }
      targets.forEach((card) => cards.delete(card.id));
      continue;
    }

    const proposed = cloneCard(change.card);
    validateMemoryCard(proposed);
    if (proposed.scope !== paths.scope) {
      throw new Error(
        `Card ${proposed.id} has scope ${proposed.scope}, expected ${paths.scope}.`,
      );
    }
    if (
      purge.idFingerprints.has(memoryPurgeFingerprint("id", proposed.id)) ||
      purge.logicalKeyFingerprints.has(
        memoryPurgeFingerprint("logical-key", proposed.logicalKey),
      ) ||
      cardMatchesPurgedValue(proposed, purge)
    ) {
      throw new Error(`Memory ${proposed.id} is blocked by the purge ledger.`);
    }

    if (change.type === "create") {
      if (cards.has(proposed.id)) {
        throw new Error(`Memory card already exists: ${proposed.id}`);
      }
      if (proposed.revision !== 1) {
        throw new Error("A newly created memory must start at revision 1.");
      }
      cards.set(proposed.id, proposed);
      continue;
    }

    if (change.type === "revise") {
      const current = cards.get(proposed.id);
      if (!current) throw new Error(`Cannot revise missing card: ${proposed.id}`);
      assertExpectedRevision(current, change.expectedRevision);
      if (current.logicalKey !== proposed.logicalKey) {
        throw new Error("A revision cannot change its logical key.");
      }
      if (proposed.revision !== current.revision + 1) {
        throw new Error(
          `Revision for ${proposed.id} must be ${current.revision + 1}.`,
        );
      }
      proposed.supersedes = sortedUnique([
        ...proposed.supersedes,
        memoryCardRef(current),
      ]);
      cards.set(proposed.id, proposed);
      continue;
    }

    const explicitRefs = new Set(proposed.supersedes);
    let targets = [...cards.values()].filter((card) =>
      explicitRefs.has(card.id) || explicitRefs.has(memoryCardRef(card)));
    if (targets.length === 0) {
      targets = [...cards.values()]
        .filter((card) => card.logicalKey === proposed.logicalKey);
    }
    if (targets.length === 0) {
      throw new Error(`Cannot supersede missing memory: ${proposed.logicalKey}`);
    }
    if (
      change.expectedRevision !== undefined &&
      targets.some((card) => card.revision !== change.expectedRevision)
    ) {
      throw new Error(`Revision mismatch while superseding ${proposed.logicalKey}.`);
    }
    const sameIdTarget = targets.find((card) => card.id === proposed.id);
    if (
      sameIdTarget &&
      proposed.revision !== sameIdTarget.revision + 1
    ) {
      throw new Error(
        `Revision for ${proposed.id} must be ${sameIdTarget.revision + 1}.`,
      );
    }
    if (!sameIdTarget && proposed.revision !== 1) {
      throw new Error("A replacement with a new id must start at revision 1.");
    }
    proposed.supersedes = sortedUnique([
      ...proposed.supersedes,
      ...targets.map(memoryCardRef),
    ]);
    targets.forEach((card) => cards.delete(card.id));
    cards.set(proposed.id, proposed);
  }

  return [...cards.values()];
}

function validateReleaseCards(
  cards: MemoryCard[],
  paths: MemoryScopePaths,
): void {
  const ids = new Set<string>();
  for (const card of cards) {
    validateMemoryCard(card);
    if (card.scope !== paths.scope) {
      throw new Error(`Card ${card.id} is in the wrong memory scope.`);
    }
    if (ids.has(card.id)) throw new Error(`Duplicate memory card id: ${card.id}`);
    ids.add(card.id);
  }
}

function summarizeChanges(changes: MemoryChange[]): MemoryChangeSummary[] {
  return changes.map((change) =>
    change.type === "retire"
      ? { type: "retire", logicalKey: change.logicalKey }
      : {
          type: change.type,
          logicalKey: change.card.logicalKey,
          cardId: change.card.id,
          revision: change.card.revision,
        });
}

function assertExpectedRevision(
  current: MemoryCard,
  expectedRevision?: number,
): void {
  if (
    expectedRevision !== undefined &&
    current.revision !== expectedRevision
  ) {
    throw new Error(
      `Revision mismatch for ${current.id}: expected ${expectedRevision}, ` +
      `found ${current.revision}.`,
    );
  }
}

function filterPurgedCards(cards: MemoryCard[], purge: PurgeState): MemoryCard[] {
  return cards.filter((card) => {
    if (purge.idFingerprints.has(memoryPurgeFingerprint("id", card.id))) {
      return false;
    }
    if (
      purge.logicalKeyFingerprints.has(
        memoryPurgeFingerprint("logical-key", card.logicalKey),
      )
    ) {
      return false;
    }
    return !cardMatchesPurgedValue(card, purge);
  });
}

function cardMatchesPurgedValue(
  card: MemoryCard,
  purge: PurgeState,
): boolean {
  if (purge.valueFingerprints.size === 0) return false;
  const values = [
    card.title,
    card.body,
    ...card.aliases,
    ...card.conditions,
    ...card.exceptions,
    ...card.evidence.flatMap((item) =>
      item.excerpt ? [item.excerpt] : []),
  ];
  for (const rawValue of values) {
    const value = normalizePurgeValue(rawValue);
    if (
      purge.valueFingerprints.has(memoryPurgeFingerprint("value", value))
    ) {
      return true;
    }
    for (const length of purge.valueFingerprintLengths) {
      if (length <= 0 || length > value.length) continue;
      for (let start = 0; start + length <= value.length; start++) {
        if (
          purge.valueFingerprints.has(
            memoryPurgeFingerprint(
              "value",
              value.slice(start, start + length),
            ),
          )
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

function appendPurgeRecord(
  paths: MemoryScopePaths,
  record: PurgeLedgerRecord,
): void {
  ensureMemoryScopeDirectories(paths);
  fs.appendFileSync(
    paths.purgeLedgerPath,
    `${JSON.stringify(record)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

function parsePurgeRecord(raw: unknown, line: number): PurgeLedgerRecord {
  if (!isRecord(raw)) throw new Error(`Invalid purge ledger record on line ${line}.`);
  const scope = raw.scope;
  if (scope !== "global" && scope !== "project") {
    throw new Error(`Invalid purge ledger scope on line ${line}.`);
  }
  const idFingerprints = parseStringArray(
    raw.idFingerprints,
    `purge id fingerprints on line ${line}`,
  );
  const logicalKeyFingerprints = parseStringArray(
    raw.logicalKeyFingerprints,
    `purge logical-key fingerprints on line ${line}`,
  );
  const valueFingerprints = raw.valueFingerprints === undefined
    ? []
    : parseStringArray(
        raw.valueFingerprints,
        `purge value fingerprints on line ${line}`,
      );
  const valueFingerprintLengths = raw.valueFingerprintLengths === undefined
    ? []
    : parsePositiveIntegerArray(
        raw.valueFingerprintLengths,
        `purge value fingerprint lengths on line ${line}`,
      );
  const sessionIdFingerprints = raw.sessionIdFingerprints === undefined
    ? []
    : parseStringArray(
        raw.sessionIdFingerprints,
        `purge session-id fingerprints on line ${line}`,
      );
  if (
    raw.schemaVersion !== 1 ||
    typeof raw.purgeId !== "string" ||
    typeof raw.epoch !== "number" ||
    !Number.isInteger(raw.epoch) ||
    raw.epoch < 1 ||
    typeof raw.createdAt !== "string"
  ) {
    throw new Error(`Invalid purge ledger record on line ${line}.`);
  }
  return {
    schemaVersion: 1,
    purgeId: raw.purgeId,
    epoch: raw.epoch,
    scope,
    ...(typeof raw.projectId === "string" ? { projectId: raw.projectId } : {}),
    idFingerprints,
    logicalKeyFingerprints,
    valueFingerprints,
    valueFingerprintLengths,
    sessionIdFingerprints,
    createdAt: raw.createdAt,
  };
}

function parseManifest(raw: unknown): ReleaseManifest {
  if (!isRecord(raw)) throw new Error("Release manifest must be an object.");
  if (
    raw.schemaVersion !== 1 ||
    typeof raw.releaseId !== "string" ||
    (raw.parentReleaseId !== null && typeof raw.parentReleaseId !== "string") ||
    (raw.scope !== "global" && raw.scope !== "project") ||
    typeof raw.createdAt !== "string" ||
    typeof raw.purgeEpoch !== "number" ||
    !Number.isInteger(raw.purgeEpoch) ||
    raw.purgeEpoch < 0 ||
    !Array.isArray(raw.changes) ||
    !isRecord(raw.fileHashes)
  ) {
    throw new Error("Malformed release manifest.");
  }
  const fileHashes: Record<string, string> = {};
  for (const [file, hash] of Object.entries(raw.fileHashes)) {
    if (typeof hash !== "string") throw new Error("Malformed release file hash.");
    fileHashes[file] = hash;
  }
  if (
    !["PROFILE.md", "INDEX.md", "catalog.tsv"]
      .every((file) => Object.hasOwn(fileHashes, file))
  ) {
    throw new Error("Release manifest is missing a derived file hash.");
  }
  return {
    schemaVersion: 1,
    releaseId: raw.releaseId,
    parentReleaseId: raw.parentReleaseId,
    ...(typeof raw.rollbackOf === "string"
      ? { rollbackOf: raw.rollbackOf }
      : {}),
    scope: raw.scope,
    ...(typeof raw.projectId === "string" ? { projectId: raw.projectId } : {}),
    createdAt: raw.createdAt,
    ...(typeof raw.reason === "string" ? { reason: raw.reason } : {}),
    purgeEpoch: raw.purgeEpoch,
    changes: raw.changes as MemoryChangeSummary[],
    fileHashes,
  };
}

function buildFileHashes(directory: string): Record<string, string> {
  const errors: string[] = [];
  const files = listFilesSafely(directory, errors)
    .filter((relativePath) =>
      relativePath !== MANIFEST_FILE && relativePath !== MANIFEST_HASH_FILE)
    .sort();
  if (errors.length > 0) throw new Error(errors.join("; "));
  const hashes: Record<string, string> = {};
  for (const relativePath of files) {
    hashes[relativePath] = sha256(
      fs.readFileSync(path.join(directory, relativePath)),
    );
  }
  return hashes;
}

function listFilesSafely(directory: string, errors: string[]): string[] {
  const files: string[] = [];
  const visit = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      const relativePath = path.relative(directory, fullPath)
        .split(path.sep).join("/");
      if (entry.isSymbolicLink()) {
        errors.push(`Release contains a symbolic link: ${relativePath}`);
      } else if (entry.isDirectory()) {
        visit(fullPath);
      } else if (entry.isFile()) {
        files.push(relativePath);
      } else {
        errors.push(`Release contains an unsupported entry: ${relativePath}`);
      }
    }
  };
  visit(directory);
  return files;
}

export function withMemoryScopeLock<T>(
  paths: MemoryScopePaths,
  operation: () => T,
): T {
  ensureMemoryScopeDirectories(paths);
  recoverStaleLock(paths.lockPath);
  let descriptor: number;
  try {
    descriptor = fs.openSync(paths.lockPath, "wx", 0o600);
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") {
      throw new MemoryScopeLockedError(paths.lockPath);
    }
    throw error;
  }
  try {
    fs.writeFileSync(
      descriptor,
      `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`,
      "utf8",
    );
    fs.closeSync(descriptor);
    descriptor = -1;
    return operation();
  } finally {
    if (descriptor >= 0) fs.closeSync(descriptor);
    try {
      fs.unlinkSync(paths.lockPath);
    } catch {
      // A completed publisher must not fail because lock cleanup raced.
    }
  }
}

function recoverStaleLock(lockPath: string): void {
  if (!fs.existsSync(lockPath)) return;
  const stat = fs.statSync(lockPath);
  if (Date.now() - stat.mtimeMs <= LOCK_STALE_AFTER_MS) return;

  let pid: number | undefined;
  try {
    const raw = JSON.parse(fs.readFileSync(lockPath, "utf8")) as {
      pid?: unknown;
    };
    if (typeof raw.pid === "number") pid = raw.pid;
  } catch {
    // An old malformed lock can be recovered after the stale timeout.
  }
  if (pid !== undefined && processExists(pid)) return;
  fs.unlinkSync(lockPath);
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error) && error.code === "EPERM";
  }
}

function assertCurrent(
  paths: MemoryScopePaths,
  expected: string | null,
): void {
  const actual = readCurrentReleaseId(paths);
  if (actual !== expected) throw new MemoryCasError(expected, actual);
}

function writeCurrentAtomically(
  paths: MemoryScopePaths,
  releaseId: string,
): void {
  const tempPath = path.join(
    paths.scopeDir,
    `.CURRENT.${randomUUID().slice(0, 8)}.tmp`,
  );
  fs.writeFileSync(tempPath, `${releaseId}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tempPath, paths.currentPath);
}

function makeReleaseReadOnly(releaseDir: string): void {
  const directories: string[] = [];
  const visit = (directory: string): void => {
    directories.push(directory);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(fullPath);
      else if (entry.isFile()) fs.chmodSync(fullPath, 0o444);
    }
  };
  visit(releaseDir);
  directories.reverse().forEach((directory) => fs.chmodSync(directory, 0o555));
}

function generateReleaseId(): string {
  return `rel_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
}

function assertSafeReleaseId(releaseId: string): void {
  if (!RELEASE_ID_PATTERN.test(releaseId)) {
    throw new Error(`Unsafe memory release id: ${releaseId}`);
  }
}

function isSafeRelativePath(relativePath: string): boolean {
  if (
    !relativePath ||
    path.isAbsolute(relativePath) ||
    relativePath.includes("\\")
  ) {
    return false;
  }
  const segments = relativePath.split("/");
  return !segments.includes("") &&
    !segments.includes(".") &&
    !segments.includes("..");
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function memoryPurgeFingerprint(
  domain: "id" | "logical-key" | "value" | "session-id",
  value: string,
): string {
  const canonical = domain === "value" ? normalizePurgeValue(value) : value;
  return sha256(`rubato-memory-purge:${domain}:v1\0${canonical}`);
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim()))].sort();
}

function sortedUniqueNumbers(values: number[]): number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}

function normalizePurgeValue(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase();
}

function cloneCard(card: MemoryCard): MemoryCard {
  return parseMemoryCard(serializeMemoryCard(card));
}

function compareCards(a: MemoryCard, b: MemoryCard): number {
  return a.id.localeCompare(b.id);
}

function parseStringArray(value: unknown, field: string): string[] {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string")
  ) {
    throw new Error(`Invalid ${field}.`);
  }
  return value;
}

function parsePositiveIntegerArray(value: unknown, field: string): number[] {
  if (
    !Array.isArray(value) ||
    value.some((item) =>
      typeof item !== "number" ||
      !Number.isInteger(item) ||
      item <= 0)
  ) {
    throw new Error(`Invalid ${field}.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
