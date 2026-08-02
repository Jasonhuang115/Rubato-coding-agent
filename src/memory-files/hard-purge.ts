import { createHash, randomUUID } from "crypto";
import fs from "fs";
import path from "path";
import { parseMemoryCard } from "./card.js";
import {
  controlEventPath,
  listMemoryControlEvents,
  rewriteMemoryControlEvents,
} from "./control-events.js";
import {
  memoryPurgeFingerprint,
  purgeMemoriesWithinLock,
  readCurrentReleaseId,
  withMemoryScopeLock,
} from "./release.js";
import { projectMemoryId, resolveMemoryScopePaths } from "./paths.js";
import type { MemoryCard, MemoryScopePaths } from "./types.js";

export type HardPurgeIntent = "forget" | "purge";

export interface HardPurgeTargets {
  ids?: string[];
  logicalKeys?: string[];
  values?: string[];
}

export interface HardPurgeOptions {
  /**
   * Rubato's data root (normally ~/.rubato). Passing ~/.rubato/memory is also
   * accepted so callers do not have to strip the final memory segment.
   */
  memoryRoot: string;
  workdir: string;
  scope: "global" | "project";
  intent?: HardPurgeIntent;
  targets: HardPurgeTargets;
  /** undefined means compare against CURRENT captured under the scope lock. */
  baseReleaseId?: string | null;
  releaseId?: string;
  createdAt?: string;
}

export type HardPurgeCategory =
  | "current_release"
  | "release"
  | "observation"
  | "candidate"
  | "dream"
  | "session"
  | "session_summary"
  | "session_catalog"
  | "access"
  | "control_event"
  | "outcome"
  | "derived_skill";

export type HardPurgeAction =
  | "publish_sanitized_release"
  | "delete_file"
  | "delete_directory"
  | "rewrite_file";

export interface HardPurgeLocation {
  category: HardPurgeCategory;
  action: HardPurgeAction;
  path: string;
  matchCount: number;
}

export interface HardPurgeResidual {
  path: string;
  reason:
    | "unclassified_skill"
    | "symbolic_link_not_followed"
    | "unsupported_artifact"
    | "unreadable"
    | "cleanup_failed"
    | "post_scan_match"
    | "active_session_may_rewrite_summary";
}

export interface HardPurgePlan {
  intent: HardPurgeIntent;
  scope: "global" | "project";
  projectId: string;
  baseReleaseId: string | null;
  locations: HardPurgeLocation[];
  residuals: HardPurgeResidual[];
  fingerprints: {
    ids: string[];
    logicalKeys: string[];
    values: string[];
  };
}

export interface HardPurgeResult {
  plan: HardPurgePlan;
  releaseId: string;
  removedPaths: string[];
  rewrittenPaths: string[];
  residuals: HardPurgeResidual[];
  postScanMatches: string[];
  complete: boolean;
}

interface NormalizedTargets {
  ids: string[];
  logicalKeys: string[];
  explicitValues: string[];
}

interface PurgeNeedle {
  kind: "id" | "logical-key" | "value";
  value: string;
  folded: string;
}

interface InternalLocation extends HardPurgeLocation {
  sessionIds?: string[];
}

interface InternalPlan {
  publicPlan: HardPurgePlan;
  paths: MemoryScopePaths;
  artifactScopePaths: MemoryScopePaths[];
  rubatoRoot: string;
  workdir: string;
  sessionStores: SessionStoreLocation[];
  needles: PurgeNeedle[];
  locations: InternalLocation[];
  purgeIds: string[];
  purgeLogicalKeys: string[];
  purgeValues: string[];
  purgeSessionIds: string[];
}

interface SessionStoreLocation {
  sessionsDir: string;
  summaryPath?: string;
  catalogPath?: string;
}

export function previewHardPurge(options: HardPurgeOptions): HardPurgePlan {
  return buildHardPurgePlan(options).publicPlan;
}

export function hardPurgeMemories(
  options: HardPurgeOptions,
): HardPurgeResult {
  const initial = resolveOptions(options);
  return withMemoryScopeLock(initial.paths, () => {
    const actualCurrent = readCurrentReleaseId(initial.paths);
    const expectedCurrent = options.baseReleaseId === undefined
      ? actualCurrent
      : options.baseReleaseId;
    if (actualCurrent !== expectedCurrent) {
      throw new Error(
        `Hard purge CURRENT changed: expected ${expectedCurrent ?? "<none>"}, ` +
        `found ${actualCurrent ?? "<none>"}.`,
      );
    }

    // Re-scan under the same publication lock. The preview is informational;
    // this plan is the authoritative set of physical changes.
    const plan = buildHardPurgePlan({
      ...options,
      baseReleaseId: expectedCurrent,
    });
    const release = purgeMemoriesWithinLock(plan.paths, {
      baseReleaseId: expectedCurrent,
      ids: plan.purgeIds,
      logicalKeys: plan.purgeLogicalKeys,
      values: plan.purgeValues,
      sessionIds: plan.purgeSessionIds,
      releaseId: options.releaseId,
      createdAt: options.createdAt,
    });

    const removedPaths: string[] = [];
    const rewrittenPaths: string[] = [];
    const residuals = [...plan.publicPlan.residuals];
    const removedSessionIds = new Set(plan.purgeSessionIds);

    for (const location of plan.locations) {
      if (location.action === "publish_sanitized_release") continue;
      // The newly published release did not exist during planning, but retain
      // this guard so a caller-supplied release id can never be removed.
      if (isWithin(location.path, release.dir)) continue;
      try {
        if (location.action === "delete_file") {
          if (fs.existsSync(location.path)) fs.unlinkSync(location.path);
          removedPaths.push(location.path);
          location.sessionIds?.forEach((id) => removedSessionIds.add(id));
        } else if (location.action === "delete_directory") {
          makeTreeWritable(location.path);
          fs.rmSync(location.path, { recursive: true, force: true });
          removedPaths.push(location.path);
        } else if (location.category === "session_summary") {
          rewriteSessionSummary(
            location.path,
            plan.needles,
            removedSessionIds,
          );
          rewrittenPaths.push(location.path);
        } else if (location.category === "session_catalog") {
          rewriteSessionCatalog(
            location.path,
            plan.needles,
            removedSessionIds,
          );
          rewrittenPaths.push(location.path);
        } else if (location.category === "outcome") {
          rewriteOutcomeChain(location.path, plan.needles);
          rewrittenPaths.push(location.path);
        } else if (location.category === "control_event") {
          rewriteControlEventChain(
            location.path,
            plan.rubatoRoot,
            plan.needles,
          );
          rewrittenPaths.push(location.path);
        } else {
          filterJsonLinesAtomically(location.path, plan.needles);
          rewrittenPaths.push(location.path);
        }
      } catch {
        residuals.push({
          path: location.path,
          reason: "cleanup_failed",
        });
      }
    }

    const currentAfterCleanup = readCurrentReleaseId(plan.paths);
    if (currentAfterCleanup !== release.id) {
      throw new Error(
        `Hard purge lost CURRENT ownership: expected ${release.id}, ` +
        `found ${currentAfterCleanup ?? "<none>"}.`,
      );
    }

    const postScanMatches = scanManagedText(
      plan,
      new Set([plan.paths.purgeLedgerPath]),
    );
    for (const match of postScanMatches) {
      if (!residuals.some((item) => item.path === match)) {
        residuals.push({ path: match, reason: "post_scan_match" });
      }
    }

    return {
      plan: plan.publicPlan,
      releaseId: release.id,
      removedPaths: sortedUnique(removedPaths),
      rewrittenPaths: sortedUnique(rewrittenPaths),
      residuals: dedupeResiduals(residuals),
      postScanMatches,
      complete: residuals.length === 0 && postScanMatches.length === 0,
    };
  });
}

function buildHardPurgePlan(options: HardPurgeOptions): InternalPlan {
  const resolved = resolveOptions(options);
  const targets = normalizeTargets(options.targets, resolved.intent);
  const identity = discoverTargetIdentity(resolved.artifactScopePaths, targets);
  const needles = buildNeedles({
    ids: sortedUnique([...targets.ids, ...identity.ids]),
    logicalKeys: sortedUnique([
      ...targets.logicalKeys,
      ...identity.logicalKeys,
    ]),
    explicitValues: sortedUnique([
      ...targets.explicitValues,
      ...identity.values,
    ]),
  });
  const locations: InternalLocation[] = [{
    category: "current_release",
    action: "publish_sanitized_release",
    path: resolved.paths.scopeDir,
    matchCount: Math.max(1, needles.length),
  }];
  const residuals: HardPurgeResidual[] = [
    ...resolved.sessionDiscoveryResiduals,
  ];

  for (const scopePaths of resolved.artifactScopePaths) {
    planReleaseCleanup(scopePaths, needles, locations, residuals);
    planJsonlRewrites(
      path.join(scopePaths.scopeDir, "observations"),
      "observation",
      needles,
      locations,
      residuals,
    );
    planFileDeletes(
      path.join(scopePaths.scopeDir, "candidates"),
      "candidate",
      needles,
      locations,
      residuals,
    );
    planDreamCleanup(
      path.join(scopePaths.scopeDir, "dreams"),
      needles,
      locations,
      residuals,
    );
  }
  planSessionCleanup(
    resolved.sessionStores,
    needles,
    new Set(identity.sessionIds),
    locations,
    residuals,
  );
  planAccessCleanup(
    path.join(resolved.paths.memoryDir, "access.jsonl"),
    needles,
    locations,
    residuals,
  );
  planControlEventCleanup(
    controlEventPath(resolved.rubatoRoot),
    needles,
    locations,
    residuals,
  );
  planSkillCleanup(
    resolved.rubatoRoot,
    options.workdir,
    needles,
    locations,
    residuals,
  );
  planOutcomeCleanup(
    path.join(resolved.rubatoRoot, "memory", "outcomes.jsonl"),
    needles,
    locations,
    residuals,
  );
  const purgeIds = sortedUnique([...targets.ids, ...identity.ids]);
  const purgeLogicalKeys = sortedUnique([
    ...targets.logicalKeys,
    ...identity.logicalKeys,
  ]);
  const purgeValues = sortedUnique(targets.explicitValues);
  const purgeSessionIds = sortedUnique([
    ...identity.sessionIds,
    ...locations.flatMap((location) => location.sessionIds ?? []),
  ]);
  const publicPlan: HardPurgePlan = {
    intent: resolved.intent,
    scope: options.scope,
    projectId: resolved.projectId,
    baseReleaseId: options.baseReleaseId === undefined
      ? readCurrentReleaseId(resolved.paths)
      : options.baseReleaseId,
    locations: locations
      .map(({ sessionIds: _sessionIds, ...location }) => location)
      .sort(compareLocations),
    residuals: dedupeResiduals(residuals),
    fingerprints: {
      ids: purgeIds.map((id) => memoryPurgeFingerprint("id", id)),
      logicalKeys: purgeLogicalKeys.map((key) =>
        memoryPurgeFingerprint("logical-key", key)),
      values: targets.explicitValues.map((value) =>
        memoryPurgeFingerprint("value", value)),
    },
  };
  return {
    publicPlan,
    paths: resolved.paths,
    artifactScopePaths: resolved.artifactScopePaths,
    rubatoRoot: resolved.rubatoRoot,
    workdir: path.resolve(options.workdir),
    sessionStores: resolved.sessionStores,
    needles,
    locations: locations.sort(compareLocations),
    purgeIds,
    purgeLogicalKeys,
    purgeValues,
    purgeSessionIds,
  };
}

function resolveOptions(options: HardPurgeOptions): {
  rubatoRoot: string;
  paths: MemoryScopePaths;
  artifactScopePaths: MemoryScopePaths[];
  projectId: string;
  sessionStores: SessionStoreLocation[];
  sessionDiscoveryResiduals: HardPurgeResidual[];
  intent: HardPurgeIntent;
} {
  if (!options.memoryRoot.trim()) throw new Error("memoryRoot is required.");
  if (!options.workdir.trim()) throw new Error("workdir is required.");
  const suppliedRoot = path.resolve(options.memoryRoot);
  const rubatoRoot = path.basename(suppliedRoot) === "memory"
    ? path.dirname(suppliedRoot)
    : suppliedRoot;
  const projectId = projectMemoryId(options.workdir);
  const paths = resolveMemoryScopePaths({
    rootDir: rubatoRoot,
    scope: options.scope,
    ...(options.scope === "project" ? { projectId } : {}),
  });
  const artifactScopePaths = [paths];
  const sessionStorage = discoverSessionStorage(
    rubatoRoot,
    options.scope,
    projectId,
  );
  return {
    rubatoRoot,
    paths,
    artifactScopePaths,
    projectId,
    sessionStores: sessionStorage.stores,
    sessionDiscoveryResiduals: sessionStorage.residuals,
    intent: options.intent ?? "forget",
  };
}

function discoverSessionStorage(
  rubatoRoot: string,
  scope: "global" | "project",
  projectId: string,
): {
  stores: SessionStoreLocation[];
  residuals: HardPurgeResidual[];
} {
  const residuals: HardPurgeResidual[] = [];
  let projectBaseDirs: string[];
  if (scope === "project") {
    projectBaseDirs = [path.join(rubatoRoot, "projects", projectId)];
  } else {
    projectBaseDirs = [];
    const projectsRoot = path.join(rubatoRoot, "projects");
    if (fs.existsSync(projectsRoot)) {
      try {
        if (fs.lstatSync(projectsRoot).isSymbolicLink()) {
          residuals.push({
            path: projectsRoot,
            reason: "symbolic_link_not_followed",
          });
        } else {
          for (const entry of fs.readdirSync(projectsRoot, {
            withFileTypes: true,
          })) {
            const entryPath = path.join(projectsRoot, entry.name);
            if (entry.isSymbolicLink()) {
              residuals.push({
                path: entryPath,
                reason: "symbolic_link_not_followed",
              });
            } else if (
              entry.isDirectory() &&
              /^[a-f0-9]{64}$/.test(entry.name)
            ) {
              projectBaseDirs.push(entryPath);
            } else if (entry.isDirectory()) {
              residuals.push({
                path: entryPath,
                reason: "unsupported_artifact",
              });
            }
          }
        }
      } catch {
        residuals.push({ path: projectsRoot, reason: "unreadable" });
      }
    }
  }

  const stores: SessionStoreLocation[] = projectBaseDirs.map((projectBase) => ({
    sessionsDir: path.join(projectBase, "sessions"),
    summaryPath: path.join(projectBase, "sessions.json"),
    catalogPath: path.join(projectBase, "session-catalog.tsv"),
  }));
  return {
    stores,
    residuals,
  };
}

function normalizeTargets(
  targets: HardPurgeTargets,
  intent: HardPurgeIntent,
): NormalizedTargets {
  const ids = sortedUnique(targets.ids ?? []);
  const logicalKeys = sortedUnique(targets.logicalKeys ?? []);
  const explicitValues = sortedUnique(targets.values ?? []);
  if (intent === "forget" && ids.length === 0 && logicalKeys.length === 0) {
    throw new Error("forget requires at least one memory id or logical key.");
  }
  if (
    ids.length === 0 &&
    logicalKeys.length === 0 &&
    explicitValues.length === 0
  ) {
    throw new Error("Hard purge requires at least one target.");
  }
  for (const value of explicitValues) {
    if (value.length < 4) {
      throw new Error(
        "Value-only purge targets must contain at least four characters.",
      );
    }
  }
  return { ids, logicalKeys, explicitValues };
}

function discoverTargetIdentity(
  scopePaths: MemoryScopePaths[],
  targets: NormalizedTargets,
): {
  ids: string[];
  logicalKeys: string[];
  values: string[];
  sessionIds: string[];
} {
  const ids = new Set<string>();
  const logicalKeys = new Set<string>();
  const values = new Set<string>();
  const sessionIds = new Set<string>();
  const matchedCards: MemoryCard[] = [];
  const otherCards: MemoryCard[] = [];
  const explicitNeedles = buildNeedles(targets);
  for (const paths of scopePaths) {
    for (const releaseEntry of safeReadDir(paths.releasesDir)) {
      if (!releaseEntry.isDirectory() || releaseEntry.isSymbolicLink()) continue;
      const cardsDir = path.join(paths.releasesDir, releaseEntry.name, "cards");
      for (const entry of safeReadDir(cardsDir)) {
        if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
        try {
          const card = parseMemoryCard(
            fs.readFileSync(path.join(cardsDir, entry.name), "utf8"),
          );
          const identityMatch =
            targets.ids.includes(card.id) ||
            targets.logicalKeys.includes(card.logicalKey);
          const valueMatch = explicitNeedles.some((needle) =>
            needle.kind === "value" && cardContains(card, needle));
          if (identityMatch || valueMatch) matchedCards.push(card);
          else otherCards.push(card);
        } catch {
          // Corrupt releases are handled as residuals by the tree scanner.
        }
      }
    }
  }

  // Derived text helps remove summaries that omitted an id/key. Never broaden
  // a purge with text also owned by a non-target card: a generic shared phrase
  // such as "Use Chinese by default" must not erase unrelated memories.
  const protectedValues = new Set(
    otherCards.flatMap(cardDerivedValues)
      .map((value) => value.toLocaleLowerCase()),
  );
  for (const card of matchedCards) {
    ids.add(card.id);
    logicalKeys.add(card.logicalKey);
    card.evidence.forEach((item) => sessionIds.add(item.sessionId));
    for (const value of cardDerivedValues(card)) {
      if (!protectedValues.has(value.toLocaleLowerCase())) values.add(value);
    }
  }
  return {
    ids: [...ids],
    logicalKeys: [...logicalKeys],
    values: [...values],
    sessionIds: [...sessionIds],
  };
}

function buildNeedles(targets: NormalizedTargets): PurgeNeedle[] {
  const needles: PurgeNeedle[] = [];
  for (const value of targets.ids) {
    needles.push({ kind: "id", value, folded: value.toLocaleLowerCase() });
  }
  for (const value of targets.logicalKeys) {
    needles.push({
      kind: "logical-key",
      value,
      folded: value.toLocaleLowerCase(),
    });
  }
  for (const value of targets.explicitValues) {
    needles.push({ kind: "value", value, folded: value.toLocaleLowerCase() });
  }
  const unique = new Map<string, PurgeNeedle>();
  for (const needle of needles) {
    unique.set(`${needle.kind}\0${needle.folded}`, needle);
  }
  return [...unique.values()];
}

function cardDerivedValues(card: MemoryCard): string[] {
  return sortedUnique([
    card.title,
    card.body.trim(),
    ...card.aliases,
    ...card.conditions,
    ...card.exceptions,
    ...card.evidence.flatMap((item) =>
      item.excerpt ? [item.excerpt] : []),
  ].filter((value) => value.trim().length >= 8));
}

function cardContains(card: MemoryCard, needle: PurgeNeedle): boolean {
  return textContains(
    [
      card.id,
      card.logicalKey,
      card.title,
      card.body,
      ...card.aliases,
      ...card.conditions,
      ...card.exceptions,
      ...card.evidence.flatMap((item) =>
        item.excerpt ? [item.excerpt] : []),
    ].join("\n"),
    [needle],
  ) > 0;
}

function planReleaseCleanup(
  paths: MemoryScopePaths,
  needles: PurgeNeedle[],
  locations: InternalLocation[],
  residuals: HardPurgeResidual[],
): void {
  for (const entry of safeReadDir(paths.releasesDir)) {
    const releasePath = path.join(paths.releasesDir, entry.name);
    if (entry.isSymbolicLink()) {
      residuals.push({
        path: releasePath,
        reason: "symbolic_link_not_followed",
      });
      continue;
    }
    if (!entry.isDirectory()) continue;
    const scan = scanTree(releasePath, needles);
    residuals.push(...scan.residuals);
    if (scan.matchCount > 0) {
      locations.push({
        category: "release",
        action: "delete_directory",
        path: releasePath,
        matchCount: scan.matchCount,
      });
    }
  }
}

function planJsonlRewrites(
  root: string,
  category: "observation",
  needles: PurgeNeedle[],
  locations: InternalLocation[],
  residuals: HardPurgeResidual[],
): void {
  walkFiles(root, (filePath) => {
    if (!filePath.endsWith(".jsonl")) return;
    const result = countMatchingLines(filePath, needles);
    if (result.error) {
      residuals.push({ path: filePath, reason: result.error });
    } else if (result.matches > 0) {
      locations.push({
        category,
        action: "rewrite_file",
        path: filePath,
        matchCount: result.matches,
      });
    }
  }, residuals);
}

function planFileDeletes(
  root: string,
  category: "candidate",
  needles: PurgeNeedle[],
  locations: InternalLocation[],
  residuals: HardPurgeResidual[],
): void {
  walkFiles(root, (filePath) => {
    const result = scanTextFile(filePath, needles);
    if (result.error) {
      residuals.push({ path: filePath, reason: result.error });
    } else if (result.matches > 0) {
      locations.push({
        category,
        action: "delete_file",
        path: filePath,
        matchCount: result.matches,
      });
    }
  }, residuals);
}

function planDreamCleanup(
  dreamsRoot: string,
  needles: PurgeNeedle[],
  locations: InternalLocation[],
  residuals: HardPurgeResidual[],
): void {
  for (const entry of safeReadDir(dreamsRoot)) {
    const runPath = path.join(dreamsRoot, entry.name);
    if (entry.isSymbolicLink()) {
      residuals.push({
        path: runPath,
        reason: "symbolic_link_not_followed",
      });
      continue;
    }
    if (!entry.isDirectory()) {
      const result = scanTextFile(runPath, needles);
      if (result.matches > 0) {
        residuals.push({ path: runPath, reason: "unsupported_artifact" });
      }
      continue;
    }
    const scan = scanTree(runPath, needles);
    residuals.push(...scan.residuals);
    if (scan.matchCount > 0) {
      locations.push({
        category: "dream",
        action: "delete_directory",
        path: runPath,
        matchCount: scan.matchCount,
      });
    }
  }
}

function planSessionCleanup(
  stores: SessionStoreLocation[],
  needles: PurgeNeedle[],
  forcedSessionIds: Set<string>,
  locations: InternalLocation[],
  residuals: HardPurgeResidual[],
): void {
  for (const store of stores) {
    const removedIds = new Set(forcedSessionIds);

    // An index may contain the only remaining copy of a sensitive summary.
    // Discover its matching IDs before deciding which transcript files go.
    if (store.summaryPath && regularFileForCleanup(
      store.summaryPath,
      residuals,
    )) {
      const preliminary = scanJsonArray(
        store.summaryPath,
        needles,
        removedIds,
      );
      if (preliminary.error) {
        residuals.push({
          path: store.summaryPath,
          reason: preliminary.error,
        });
      } else {
        preliminary.matchedIds.forEach((id) => removedIds.add(id));
      }
    }
    if (store.catalogPath && regularFileForCleanup(
      store.catalogPath,
      residuals,
    )) {
      const preliminary = scanSessionCatalog(
        store.catalogPath,
        needles,
        removedIds,
      );
      if (preliminary.error) {
        residuals.push({
          path: store.catalogPath,
          reason: preliminary.error,
        });
      } else {
        preliminary.matchedIds.forEach((id) => removedIds.add(id));
      }
    }

    for (const entry of readDirectoryForCleanup(
      store.sessionsDir,
      residuals,
    )) {
      const filePath = path.join(store.sessionsDir, entry.name);
      if (entry.isSymbolicLink()) {
        residuals.push({
          path: filePath,
          reason: "symbolic_link_not_followed",
        });
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const result = scanTextFile(filePath, needles);
      if (result.error) {
        residuals.push({ path: filePath, reason: result.error });
      } else {
        const sessionId = entry.name.slice(0, -".jsonl".length);
        if (result.matches === 0 && !removedIds.has(sessionId)) continue;
        removedIds.add(sessionId);
        locations.push({
          category: "session",
          action: "delete_file",
          path: filePath,
          matchCount: Math.max(1, result.matches),
          sessionIds: [sessionId],
        });
        if (!sessionIsClosed(filePath)) {
          residuals.push({
            path: filePath,
            reason: "active_session_may_rewrite_summary",
          });
        }
      }
    }

    if (store.summaryPath && regularFileForCleanup(
      store.summaryPath,
      residuals,
    )) {
      const summaryMatches = scanJsonArray(
        store.summaryPath,
        needles,
        removedIds,
      );
      if (summaryMatches.error) {
        residuals.push({
          path: store.summaryPath,
          reason: summaryMatches.error,
        });
      } else if (summaryMatches.matches > 0) {
        summaryMatches.matchedIds.forEach((id) => removedIds.add(id));
        locations.push({
          category: "session_summary",
          action: "rewrite_file",
          path: store.summaryPath,
          matchCount: summaryMatches.matches,
          sessionIds: summaryMatches.matchedIds,
        });
      }
    }

    if (store.catalogPath && regularFileForCleanup(
      store.catalogPath,
      residuals,
    )) {
      const catalogMatches = scanSessionCatalog(
        store.catalogPath,
        needles,
        removedIds,
      );
      if (catalogMatches.error) {
        residuals.push({
          path: store.catalogPath,
          reason: catalogMatches.error,
        });
      } else if (catalogMatches.matches > 0) {
        catalogMatches.matchedIds.forEach((id) => removedIds.add(id));
        locations.push({
          category: "session_catalog",
          action: "rewrite_file",
          path: store.catalogPath,
          matchCount: catalogMatches.matches,
          sessionIds: catalogMatches.matchedIds,
        });
      }
    }
  }
}

function planSkillCleanup(
  rubatoRoot: string,
  workdir: string,
  needles: PurgeNeedle[],
  locations: InternalLocation[],
  residuals: HardPurgeResidual[],
): void {
  for (const skillsRoot of [
    path.join(rubatoRoot, "skills"),
    path.join(path.resolve(workdir), ".rubato", "skills"),
  ]) {
    for (const entry of safeReadDir(skillsRoot)) {
      const skillPath = path.join(skillsRoot, entry.name);
      if (entry.isSymbolicLink()) {
        residuals.push({
          path: skillPath,
          reason: "symbolic_link_not_followed",
        });
        continue;
      }
      const scan = entry.isDirectory()
        ? scanTree(skillPath, needles)
        : scanTextFile(skillPath, needles);
      if ("residuals" in scan) residuals.push(...scan.residuals);
      if (scan.matches === 0 && !("matchCount" in scan && scan.matchCount > 0)) {
        continue;
      }
      const content = readTreeText(skillPath);
      if (!content || !isDerivedSkill(content)) {
        residuals.push({ path: skillPath, reason: "unclassified_skill" });
        continue;
      }
      locations.push({
        category: "derived_skill",
        action: entry.isDirectory() ? "delete_directory" : "delete_file",
        path: skillPath,
        matchCount: "matchCount" in scan ? scan.matchCount : scan.matches,
      });
    }
  }
}

function planOutcomeCleanup(
  outcomePath: string,
  needles: PurgeNeedle[],
  locations: InternalLocation[],
  residuals: HardPurgeResidual[],
): void {
  if (!fs.existsSync(outcomePath)) return;
  const result = countMatchingLines(outcomePath, needles);
  if (result.error) {
    residuals.push({ path: outcomePath, reason: result.error });
  } else if (result.matches > 0) {
    locations.push({
      category: "outcome",
      action: "rewrite_file",
      path: outcomePath,
      matchCount: result.matches,
    });
  }
}

function planAccessCleanup(
  accessPath: string,
  needles: PurgeNeedle[],
  locations: InternalLocation[],
  residuals: HardPurgeResidual[],
): void {
  if (!fs.existsSync(accessPath)) return;
  const result = countMatchingLines(accessPath, needles);
  if (result.error) {
    residuals.push({ path: accessPath, reason: result.error });
  } else if (result.matches > 0) {
    locations.push({
      category: "access",
      action: "rewrite_file",
      path: accessPath,
      matchCount: result.matches,
    });
  }
}

function planControlEventCleanup(
  filePath: string,
  needles: PurgeNeedle[],
  locations: InternalLocation[],
  residuals: HardPurgeResidual[],
): void {
  if (!fs.existsSync(filePath)) return;
  const result = countMatchingLines(filePath, needles);
  if (result.error) {
    residuals.push({ path: filePath, reason: result.error });
  } else if (result.matches > 0) {
    locations.push({
      category: "control_event",
      action: "rewrite_file",
      path: filePath,
      matchCount: result.matches,
    });
  }
}

function scanManagedText(
  plan: InternalPlan,
  excluded: Set<string>,
): string[] {
  const roots = [
    ...plan.artifactScopePaths.map((paths) => paths.scopeDir),
    ...plan.sessionStores.flatMap((store) => [
      store.sessionsDir,
      ...(store.summaryPath ? [store.summaryPath] : []),
      ...(store.catalogPath ? [store.catalogPath] : []),
    ]),
    path.join(plan.rubatoRoot, "skills"),
    path.join(plan.workdir, ".rubato", "skills"),
  ];
  const matches = new Set<string>();
  for (const root of roots) {
    walkFiles(root, (filePath) => {
      if ([...excluded].some((item) => isWithin(filePath, item))) return;
      const result = scanTextFile(filePath, plan.needles);
      if (result.matches > 0) matches.add(filePath);
    }, []);
  }
  const accessPath = path.join(plan.paths.memoryDir, "access.jsonl");
  if (fs.existsSync(accessPath) && !excluded.has(accessPath)) {
    const result = scanTextFile(accessPath, plan.needles);
    if (result.matches > 0) matches.add(accessPath);
  }
  const controlsPath = controlEventPath(plan.rubatoRoot);
  if (fs.existsSync(controlsPath) && !excluded.has(controlsPath)) {
    const result = scanTextFile(controlsPath, plan.needles);
    if (result.matches > 0) matches.add(controlsPath);
  }
  const outcomePath = path.join(plan.paths.memoryDir, "outcomes.jsonl");
  if (fs.existsSync(outcomePath) && !excluded.has(outcomePath)) {
    const result = scanTextFile(outcomePath, plan.needles);
    if (result.matches > 0) matches.add(outcomePath);
  }
  return [...matches].sort();
}

function rewriteControlEventChain(
  filePath: string,
  rubatoRoot: string,
  needles: PurgeNeedle[],
): void {
  if (!fs.existsSync(filePath)) return;
  withExclusiveFileLock(`${filePath}.lock`, () => {
    const retained = listMemoryControlEvents(rubatoRoot)
      .filter((event) => textContains(JSON.stringify(event), needles) === 0)
      .map(({ seq: _seq, prev_hash: _previous, hash: _hash, ...event }) =>
        event);
    rewriteMemoryControlEvents(retained, rubatoRoot);
  });
}

function filterJsonLinesAtomically(
  filePath: string,
  needles: PurgeNeedle[],
): void {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  const kept = lines.filter((line) =>
    !line.trim() || textContains(line, needles) === 0);
  atomicWrite(filePath, normalizeLines(kept));
}

function rewriteSessionSummary(
  filePath: string,
  needles: PurgeNeedle[],
  removedSessionIds: Set<string>,
): void {
  if (!fs.existsSync(filePath)) return;
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  if (!Array.isArray(raw)) {
    throw new Error("Session summary is not an array.");
  }
  const retained = raw.filter((item) => {
    const id = isRecord(item) && typeof item.id === "string" ? item.id : "";
    return !removedSessionIds.has(id) &&
      textContains(JSON.stringify(item), needles) === 0;
  });
  atomicWrite(filePath, `${JSON.stringify(retained, null, 2)}\n`);
}

function rewriteSessionCatalog(
  filePath: string,
  needles: PurgeNeedle[],
  removedSessionIds: Set<string>,
): void {
  if (!fs.existsSync(filePath)) return;
  const retained = fs.readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter((line, index) => {
      if (!line.trim()) return false;
      if (index === 0 && line.startsWith("session_id\t")) return true;
      const sessionId = line.split("\t", 1)[0];
      return !removedSessionIds.has(sessionId) &&
        textContains(line, needles) === 0;
    });
  atomicWrite(filePath, retained.length > 0 ? `${retained.join("\n")}\n` : "");
}

function rewriteOutcomeChain(
  filePath: string,
  needles: PurgeNeedle[],
): void {
  if (!fs.existsSync(filePath)) return;
  const records: Record<string, unknown>[] = [];
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    if (!line.trim() || textContains(line, needles) > 0) continue;
    const parsed = JSON.parse(line) as unknown;
    if (!isRecord(parsed)) throw new Error("Malformed memory outcome.");
    records.push(parsed);
  }

  let previousHash = "0".repeat(64);
  const lines = records.map((record) => {
    const { hash: _oldHash, prev_hash: _oldPrevious, ...content } = record;
    const withoutHash = { ...content, prev_hash: previousHash };
    const next = {
      ...withoutHash,
      hash: sha256(stableJson(withoutHash)),
    };
    previousHash = next.hash;
    return JSON.stringify(next);
  });
  atomicWrite(filePath, lines.length > 0 ? `${lines.join("\n")}\n` : "");
}

function scanTree(
  root: string,
  needles: PurgeNeedle[],
): {
  matches: number;
  matchCount: number;
  residuals: HardPurgeResidual[];
} {
  let matchCount = 0;
  const residuals: HardPurgeResidual[] = [];
  walkFiles(root, (filePath) => {
    const result = scanTextFile(filePath, needles);
    if (result.error) {
      residuals.push({ path: filePath, reason: result.error });
    } else {
      matchCount += result.matches;
    }
  }, residuals);
  return { matches: matchCount, matchCount, residuals };
}

function scanTextFile(
  filePath: string,
  needles: PurgeNeedle[],
): {
  matches: number;
  error?: "unreadable" | "unsupported_artifact";
} {
  try {
    const buffer = fs.readFileSync(filePath);
    if (buffer.includes(0)) return { matches: 0, error: "unsupported_artifact" };
    return {
      matches: textContains(buffer.toString("utf8"), needles),
    };
  } catch {
    return { matches: 0, error: "unreadable" };
  }
}

function countMatchingLines(
  filePath: string,
  needles: PurgeNeedle[],
): {
  matches: number;
  error?: "unreadable" | "unsupported_artifact";
} {
  const result = scanTextFile(filePath, needles);
  if (result.error) return result;
  try {
    return {
      matches: fs.readFileSync(filePath, "utf8").split(/\r?\n/)
        .filter((line) => line.trim() && textContains(line, needles) > 0)
        .length,
    };
  } catch {
    return { matches: 0, error: "unreadable" };
  }
}

function scanJsonArray(
  filePath: string,
  needles: PurgeNeedle[],
  removedIds: Set<string>,
): {
  matches: number;
  matchedIds: string[];
  error?: "unreadable" | "unsupported_artifact";
} {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    if (!Array.isArray(raw)) {
      return {
        matches: 0,
        matchedIds: [],
        error: "unsupported_artifact",
      };
    }
    const matchedIds: string[] = [];
    let matches = 0;
    for (const item of raw) {
      const id = isRecord(item) && typeof item.id === "string" ? item.id : "";
      if (
        removedIds.has(id) ||
        textContains(JSON.stringify(item), needles) > 0
      ) {
        matches++;
        if (id) matchedIds.push(id);
      }
    }
    return {
      matches,
      matchedIds: sortedUnique(matchedIds),
    };
  } catch {
    return { matches: 0, matchedIds: [], error: "unreadable" };
  }
}

function scanSessionCatalog(
  filePath: string,
  needles: PurgeNeedle[],
  removedIds: Set<string>,
): {
  matches: number;
  matchedIds: string[];
  error?: "unreadable" | "unsupported_artifact";
} {
  const scan = scanTextFile(filePath, needles);
  if (scan.error) {
    return { matches: 0, matchedIds: [], error: scan.error };
  }
  try {
    const matchedIds: string[] = [];
    let matches = 0;
    for (const [index, line] of fs.readFileSync(filePath, "utf8")
      .split(/\r?\n/).entries()) {
      if (!line.trim() || (index === 0 && line.startsWith("session_id\t"))) {
        continue;
      }
      const sessionId = line.split("\t", 1)[0];
      if (
        removedIds.has(sessionId) ||
        textContains(line, needles) > 0
      ) {
        matches++;
        if (sessionId) matchedIds.push(sessionId);
      }
    }
    return { matches, matchedIds: sortedUnique(matchedIds) };
  } catch {
    return { matches: 0, matchedIds: [], error: "unreadable" };
  }
}

function textContains(text: string, needles: PurgeNeedle[]): number {
  const folded = text.toLocaleLowerCase();
  return needles.reduce((count, needle) =>
    count + (folded.includes(needle.folded) ? 1 : 0), 0);
}

function readTreeText(root: string): string | null {
  try {
    if (!fs.existsSync(root)) return null;
    const stat = fs.lstatSync(root);
    if (stat.isSymbolicLink()) return null;
    if (stat.isFile()) {
      const buffer = fs.readFileSync(root);
      return buffer.includes(0) ? null : buffer.toString("utf8");
    }
    const chunks: string[] = [];
    walkFiles(root, (filePath) => {
      const buffer = fs.readFileSync(filePath);
      if (!buffer.includes(0)) chunks.push(buffer.toString("utf8"));
    }, []);
    return chunks.join("\n");
  } catch {
    return null;
  }
}

function isDerivedSkill(content: string): boolean {
  return /(?:generated[_-]by|x-rubato-generated-by)\s*:\s*(?:rubato-memory|memory-dream)/i
    .test(content) ||
    /source[_-]memory[_-]ids\s*:/i.test(content);
}

function sessionIsClosed(filePath: string): boolean {
  try {
    const lines = fs.readFileSync(filePath, "utf8")
      .split(/\r?\n/)
      .filter((line) => line.trim());
    if (lines.length === 0) return false;
    const last = JSON.parse(lines.at(-1)!) as { type?: unknown };
    return last.type === "session_closed";
  } catch {
    return false;
  }
}

function walkFiles(
  root: string,
  visitor: (filePath: string) => void,
  residuals: HardPurgeResidual[],
): void {
  if (!fs.existsSync(root)) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    residuals.push({ path: root, reason: "unreadable" });
    return;
  }
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isSymbolicLink()) {
      residuals.push({
        path: entryPath,
        reason: "symbolic_link_not_followed",
      });
    } else if (entry.isDirectory()) {
      walkFiles(entryPath, visitor, residuals);
    } else if (entry.isFile()) {
      visitor(entryPath);
    }
  }
}

function safeReadDir(directory: string): fs.Dirent[] {
  try {
    return fs.existsSync(directory)
      ? fs.readdirSync(directory, { withFileTypes: true })
      : [];
  } catch {
    return [];
  }
}

function readDirectoryForCleanup(
  directory: string,
  residuals: HardPurgeResidual[],
): fs.Dirent[] {
  if (!fs.existsSync(directory)) return [];
  try {
    const stat = fs.lstatSync(directory);
    if (stat.isSymbolicLink()) {
      residuals.push({
        path: directory,
        reason: "symbolic_link_not_followed",
      });
      return [];
    }
    if (!stat.isDirectory()) {
      residuals.push({ path: directory, reason: "unsupported_artifact" });
      return [];
    }
    return fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    residuals.push({ path: directory, reason: "unreadable" });
    return [];
  }
}

function regularFileForCleanup(
  filePath: string,
  residuals: HardPurgeResidual[],
): boolean {
  if (!fs.existsSync(filePath)) return false;
  try {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink()) {
      residuals.push({
        path: filePath,
        reason: "symbolic_link_not_followed",
      });
      return false;
    }
    if (!stat.isFile()) {
      residuals.push({ path: filePath, reason: "unsupported_artifact" });
      return false;
    }
    return true;
  } catch {
    residuals.push({ path: filePath, reason: "unreadable" });
    return false;
  }
}

function atomicWrite(filePath: string, content: string): void {
  const temporary = `${filePath}.purge-${randomUUID()}.tmp`;
  const mode = fs.existsSync(filePath)
    ? fs.statSync(filePath).mode & 0o777
    : 0o600;
  const descriptor = fs.openSync(temporary, "wx", mode);
  try {
    fs.writeFileSync(descriptor, content, "utf8");
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporary, filePath);
}

function withExclusiveFileLock<T>(lockPath: string, action: () => T): T {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(lockPath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`Privacy cleanup lock is busy: ${lockPath}`);
    }
    throw error;
  }
  try {
    return action();
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // A failed unlock is surfaced by the next cleanup attempt.
    }
  }
}

function makeTreeWritable(target: string): void {
  if (!fs.existsSync(target)) return;
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink()) return;
  if (!stat.isDirectory()) {
    fs.chmodSync(target, 0o600);
    return;
  }
  fs.chmodSync(target, 0o700);
  for (const entry of fs.readdirSync(target)) {
    makeTreeWritable(path.join(target, entry));
  }
}

function normalizeLines(lines: string[]): string {
  const meaningful = lines.filter((line, index) =>
    line.length > 0 || index < lines.length - 1);
  return meaningful.length > 0 ? `${meaningful.join("\n")}\n` : "";
}

function compareLocations(
  left: Pick<HardPurgeLocation, "category" | "path">,
  right: Pick<HardPurgeLocation, "category" | "path">,
): number {
  const order: HardPurgeCategory[] = [
    "current_release",
    "observation",
    "candidate",
    "dream",
    "session",
    "session_summary",
    "session_catalog",
    "access",
    "control_event",
    "outcome",
    "derived_skill",
    "release",
  ];
  return order.indexOf(left.category) - order.indexOf(right.category) ||
    left.path.localeCompare(right.path);
}

function dedupeResiduals(
  residuals: HardPurgeResidual[],
): HardPurgeResidual[] {
  const seen = new Set<string>();
  return residuals
    .filter((item) => {
      const key = `${item.path}\0${item.reason}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.path.localeCompare(b.path) ||
      a.reason.localeCompare(b.reason));
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
    .sort();
}

function isWithin(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  if (isRecord(value)) {
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) =>
      `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
