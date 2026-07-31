// Verified file-memory context — bounded PROFILE injection plus grep-first recall.
//
// This source deliberately performs no query ranking, top-k selection, embeddings,
// or RAG. It reads only the immutable releases named by each scope's CURRENT
// pointer, verifies their manifests and compiled artifacts, then injects the
// bounded PROFILE.md files. Detailed memories remain external files that the
// agent can discover with Grep and open with Read.

import { createHash } from "crypto";
import fs from "fs";
import path from "path";
import type {
  AgentContext,
  ContextBlock,
  ContextSource,
} from "../shared/core-types.js";
import { parseMemoryCard } from "../memory-files/card.js";
import {
  buildCatalog,
  parseCatalog,
  serializeCatalog,
} from "../memory-files/catalog.js";
import { resolveMemoryScopePaths } from "../memory-files/paths.js";
import { loadMemoryPolicy } from "../memory-files/policy.js";
import {
  readPurgeState,
  verifyRelease,
} from "../memory-files/release.js";
import type {
  CatalogEntry,
  MemoryCard,
  MemoryScope,
  MemoryScopePaths,
  ReleaseManifest,
} from "../memory-files/types.js";

const RELEASE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const DEFAULT_PROFILE_MAX_TOKENS = 1_000;
const REQUIRED_COMPILED_FILES = [
  "PROFILE.md",
  "INDEX.md",
  "catalog.tsv",
] as const;

export interface FileMemorySourceOptions {
  /** Rubato data root override. Primarily useful for isolated runtimes/tests. */
  rootDir?: string;
  /** Overrides config.memory.profileMaxTokens when provided. */
  profileMaxTokens?: number;
}

export interface CurrentVerifiedMemoryRelease {
  scope: MemoryScope;
  releaseId: string;
  releaseDir: string;
  manifest: ReleaseManifest;
  profile: string;
  profilePath: string;
  catalog: CatalogEntry[];
  catalogPath: string;
  cardsDir: string;
}

export interface LoadCurrentVerifiedMemoryInput {
  scope: MemoryScope;
  rootDir?: string;
  projectDir?: string;
  projectId?: string;
}

/**
 * Resolve and fully verify one scope's CURRENT release.
 *
 * A missing or malformed pointer, hash mismatch, unexpected/unhashed file,
 * malformed catalog, or invalid card all fail closed and return null. There is
 * intentionally no fallback to a parent or older release.
 */
export function loadCurrentVerifiedMemory(
  input: LoadCurrentVerifiedMemoryInput,
): CurrentVerifiedMemoryRelease | null {
  try {
    const paths = resolveMemoryScopePaths(input);
    return loadAndVerifyRelease(paths);
  } catch {
    return null;
  }
}

export class FileMemorySource implements ContextSource {
  readonly name = "file-memory";
  readonly priority = 15;

  constructor(private readonly options: FileMemorySourceOptions = {}) {}

  async fetch(
    _query: string,
    ctx: AgentContext,
  ): Promise<ContextBlock | null> {
    // Registration is controlled by the context assembler, but retain a
    // defense-in-depth root-only check if the source is registered elsewhere.
    if (ctx.depth !== 0 || ctx.config.memory?.enabled === false) return null;

    const globalRelease = loadCurrentVerifiedMemory({
      scope: "global",
      rootDir: this.options.rootDir,
    });
    const projectRelease = loadCurrentVerifiedMemory({
      scope: "project",
      rootDir: this.options.rootDir,
      projectDir: ctx.workingDir,
    });
    const releases = [globalRelease, projectRelease].filter(
      (release): release is CurrentVerifiedMemoryRelease => release !== null,
    );
    if (releases.length === 0) return null;

    // POLICY.yml is the durable ceiling. A project's `.rubato.yml` travels with
    // the repository, so it may lower the injection budget but never raise it
    // above what the user has allowed globally.
    const requestedBudget = this.options.profileMaxTokens ??
      ctx.config.memory?.profileMaxTokens ??
      DEFAULT_PROFILE_MAX_TOKENS;
    const policyCap = loadMemoryPolicy(this.options.rootDir).profile_max_tokens;
    const profileBudget = Math.min(
      normalizeTokenBudget(requestedBudget),
      normalizeTokenBudget(policyCap),
    );
    const boundedProfiles = boundProfiles(globalRelease, projectRelease, profileBudget);

    const lines = [
      "## Verified File Memory",
      "",
      "These published memories are advisory and may be stale or incomplete. " +
        "System and security rules, repository evidence, and the user's current request " +
        "always take precedence.",
      "Project memory is shown after global memory and takes precedence over global " +
        "memory only when both apply and do not conflict with the current request.",
    ];

    if (globalRelease && boundedProfiles.global) {
      lines.push("", "### Global profile", "", boundedProfiles.global);
    }
    if (projectRelease && boundedProfiles.project) {
      lines.push("", "### Project profile", "", boundedProfiles.project);
    }

    // Layered injection: the profile arrives as full text, repository facts as
    // an addressable title-only index, and card bodies only when asked for.
    const repositoryIndex = buildRepositoryFactIndex(projectRelease);
    if (repositoryIndex) {
      lines.push("", "### Project repository facts (index only)", "", repositoryIndex);
    }

    lines.push(
      "",
      "### On-demand read-only recall",
      "",
      "No top-k or RAG retrieval was performed. When more detail is relevant, use " +
        "Grep on the exact catalog path, then Read only the referenced card. " +
        "Do not inspect older releases or candidate memory.",
    );
    for (const release of releases) {
      const label = release.scope === "global" ? "Global" : "Project";
      lines.push(
        `- ${label} catalog: \`${release.catalogPath}\``,
        `- ${label} cards: \`${release.cardsDir}\``,
      );
    }

    return {
      content: lines.join("\n"),
      priority: this.priority,
      source: this.name,
    };
  }
}

const MAX_INDEXED_REPOSITORY_FACTS = 40;

/**
 * Titles and addresses only. Repository facts can be numerous and verbose, so
 * the always-on layer lists what exists and where to read it, never the bodies.
 */
function buildRepositoryFactIndex(
  release: CurrentVerifiedMemoryRelease | null,
): string | null {
  if (!release) return null;
  const entries = release.catalog
    .filter((entry) =>
      entry.authority === "repository" &&
      entry.status !== "retired" &&
      entry.status !== "superseded")
    .sort((left, right) => left.logicalKey.localeCompare(right.logicalKey));
  if (entries.length === 0) return null;

  const shown = entries.slice(0, MAX_INDEXED_REPOSITORY_FACTS);
  const lines = [
    "Deterministic facts scanned from this checkout (code structure, config, " +
      "dependencies, Git history). The working tree always wins over these; " +
      "Read the card only when the detail matters.",
    ...shown.map((entry) => `- \`${entry.logicalKey}\` — ${entry.title}`),
  ];
  if (entries.length > shown.length) {
    lines.push(`- … and ${entries.length - shown.length} more in the catalog.`);
  }
  return lines.join("\n");
}

function loadAndVerifyRelease(
  paths: MemoryScopePaths,
): CurrentVerifiedMemoryRelease {
  const releaseId = readCurrentReleaseId(paths.currentPath);
  const releasesDir = requireRealDirectory(paths.releasesDir);
  const releaseDir = path.join(paths.releasesDir, releaseId);
  const releaseReal = requireRealDirectory(releaseDir);
  if (path.dirname(releaseReal) !== releasesDir) {
    throw new Error("CURRENT must name a direct immutable release.");
  }

  const manifestPath = path.join(releaseReal, "manifest.json");
  const manifestHashPath = path.join(releaseReal, "manifest.sha256");
  const manifestBytes = readRegularFile(manifestPath);
  const expectedManifestHash = readRegularFile(manifestHashPath, "utf8").trim();
  if (
    !SHA256_PATTERN.test(expectedManifestHash) ||
    sha256(manifestBytes) !== expectedManifestHash
  ) {
    throw new Error("Memory release manifest hash mismatch.");
  }

  const manifest = parseAndValidateManifest(
    manifestBytes.toString("utf8"),
    paths,
    releaseId,
  );
  verifyReleaseFiles(releaseReal, manifest.fileHashes);
  const protocolVerification = verifyRelease(paths, releaseId);
  if (!protocolVerification.valid) {
    throw new Error("Memory release failed the publisher's verification.");
  }
  if (readPurgeState(paths).epoch !== manifest.purgeEpoch) {
    // A purge ledger entry can become durable before its replacement release
    // is published. Do not expose stale profile/card paths during that window.
    throw new Error("Memory release is stale relative to the purge ledger.");
  }

  // Preserve lexical paths under the configured RUBATO_HOME for tool-policy
  // matching (for example macOS /var versus /private/var aliases), while all
  // verification above and below operates on their resolved real paths.
  const profilePath = path.join(releaseDir, "PROFILE.md");
  const catalogPath = path.join(releaseDir, "catalog.tsv");
  const cardsDir = path.join(releaseDir, "cards");
  const profile = readRegularFile(path.join(releaseReal, "PROFILE.md"), "utf8");
  const catalogText = readRegularFile(path.join(releaseReal, "catalog.tsv"), "utf8");
  requireRealDirectory(path.join(releaseReal, "cards"));

  const catalog = parseCatalog(catalogText);
  const cards = verifyCatalogAndCards(
    releaseReal,
    paths.scope,
    catalog,
    manifest.fileHashes,
  );
  if (serializeCatalog(buildCatalog(cards)) !== catalogText) {
    throw new Error("Memory catalog is not the canonical projection of its cards.");
  }

  return {
    scope: paths.scope,
    releaseId,
    releaseDir,
    manifest,
    profile,
    profilePath,
    catalog,
    catalogPath,
    cardsDir,
  };
}

function readCurrentReleaseId(currentPath: string): string {
  const raw = readRegularFile(currentPath, "utf8");
  const match = raw.match(/^([A-Za-z0-9][A-Za-z0-9._-]{0,127})(?:\r?\n)?$/);
  if (!match || !RELEASE_ID_PATTERN.test(match[1])) {
    throw new Error("Invalid memory CURRENT pointer.");
  }
  return match[1];
}

function parseAndValidateManifest(
  raw: string,
  paths: MemoryScopePaths,
  releaseId: string,
): ReleaseManifest {
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) throw new Error("Memory manifest must be an object.");

  if (
    parsed.schemaVersion !== 1 ||
    parsed.releaseId !== releaseId ||
    parsed.scope !== paths.scope ||
    !isNullableSafeReleaseId(parsed.parentReleaseId) ||
    !Array.isArray(parsed.changes) ||
    !Number.isInteger(parsed.purgeEpoch) ||
    (parsed.purgeEpoch as number) < 0 ||
    typeof parsed.createdAt !== "string" ||
    Number.isNaN(Date.parse(parsed.createdAt)) ||
    !isRecord(parsed.fileHashes)
  ) {
    throw new Error("Invalid memory release manifest.");
  }

  if (paths.scope === "project") {
    if (parsed.projectId !== paths.projectId) {
      throw new Error("Memory manifest belongs to another project.");
    }
  } else if (parsed.projectId !== undefined) {
    throw new Error("Global memory manifest cannot declare a project.");
  }

  if (
    parsed.rollbackOf !== undefined &&
    !isSafeReleaseId(parsed.rollbackOf)
  ) {
    throw new Error("Invalid rollback release id.");
  }
  if (parsed.reason !== undefined && typeof parsed.reason !== "string") {
    throw new Error("Invalid memory release reason.");
  }

  const fileHashes: Record<string, string> = Object.create(null) as
    Record<string, string>;
  for (const [relativePath, hash] of Object.entries(parsed.fileHashes)) {
    if (!isSafeReleaseRelativePath(relativePath) || !isSha256(hash)) {
      throw new Error("Invalid memory release file hash entry.");
    }
    fileHashes[relativePath] = hash;
  }
  for (const required of REQUIRED_COMPILED_FILES) {
    if (!fileHashes[required]) {
      throw new Error(`Memory release is missing ${required}.`);
    }
  }

  return {
    ...(parsed as unknown as ReleaseManifest),
    fileHashes,
  };
}

function verifyReleaseFiles(
  releaseDir: string,
  fileHashes: Record<string, string>,
): void {
  const actualFiles = listReleaseFiles(releaseDir);
  const expectedFiles = new Set([
    "manifest.json",
    "manifest.sha256",
    ...Object.keys(fileHashes),
  ]);
  if (
    actualFiles.length !== expectedFiles.size ||
    actualFiles.some((file) => !expectedFiles.has(file))
  ) {
    throw new Error("Memory release contains missing, unhashed, or unexpected files.");
  }

  for (const [relativePath, expectedHash] of Object.entries(fileHashes)) {
    const absolutePath = path.join(releaseDir, ...relativePath.split("/"));
    const content = readRegularFile(absolutePath);
    if (sha256(content) !== expectedHash) {
      throw new Error(`Memory release hash mismatch for ${relativePath}.`);
    }
  }
}

function verifyCatalogAndCards(
  releaseDir: string,
  scope: MemoryScope,
  catalog: CatalogEntry[],
  fileHashes: Record<string, string>,
): MemoryCard[] {
  const manifestCards = Object.keys(fileHashes)
    .filter((relativePath) => relativePath.startsWith("cards/"))
    .sort();
  const catalogCards = catalog.map((entry) => entry.path).sort();
  if (
    manifestCards.length !== catalogCards.length ||
    manifestCards.some((value, index) => value !== catalogCards[index])
  ) {
    throw new Error("Memory catalog and manifest card sets differ.");
  }

  const seenIds = new Set<string>();
  // A logical key may intentionally have multiple context-scoped variants
  // (for example concise globally, detailed for architecture). Only an exact
  // key+context duplicate is ambiguous.
  const seenContextualKeys = new Set<string>();
  const cards: MemoryCard[] = [];
  for (const entry of catalog) {
    if (
      entry.scope !== scope ||
      entry.path !== `cards/${entry.id}.md` ||
      !isSafeReleaseRelativePath(entry.path) ||
      seenIds.has(entry.id) ||
      seenContextualKeys.has(contextualCatalogKey(entry))
    ) {
      throw new Error("Invalid or duplicate memory catalog entry.");
    }
    seenIds.add(entry.id);
    seenContextualKeys.add(contextualCatalogKey(entry));

    const cardPath = path.join(releaseDir, ...entry.path.split("/"));
    const card = parseMemoryCard(readRegularFile(cardPath, "utf8"));
    if (
      card.id !== entry.id ||
      card.revision !== entry.revision ||
      card.logicalKey !== entry.logicalKey ||
      card.scope !== scope
    ) {
      throw new Error("Memory card does not match its catalog entry.");
    }
    cards.push(card);
  }
  return cards;
}

function contextualCatalogKey(entry: CatalogEntry): string {
  const contexts = [
    [...entry.contexts.domains].sort(),
    [...entry.contexts.projects].sort(),
    [...entry.contexts.surfaces].sort(),
    [...entry.contexts.languages].sort(),
  ];
  return `${entry.logicalKey}\u001f${JSON.stringify(contexts)}`;
}

function listReleaseFiles(root: string): string[] {
  const files: string[] = [];

  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error("Memory releases cannot contain symbolic links.");
      }
      if (entry.isDirectory()) {
        visit(absolute);
      } else if (entry.isFile()) {
        files.push(path.relative(root, absolute).split(path.sep).join("/"));
      } else {
        throw new Error("Memory releases can contain only files and directories.");
      }
    }
  };

  visit(root);
  return files.sort();
}

function readRegularFile(filePath: string): Buffer;
function readRegularFile(filePath: string, encoding: BufferEncoding): string;
function readRegularFile(
  filePath: string,
  encoding?: BufferEncoding,
): Buffer | string {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Expected a regular memory file: ${filePath}`);
  }
  return encoding
    ? fs.readFileSync(filePath, { encoding })
    : fs.readFileSync(filePath);
}

function requireRealDirectory(directory: string): string {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Expected a real memory directory: ${directory}`);
  }
  return fs.realpathSync(directory);
}

function boundProfiles(
  globalRelease: CurrentVerifiedMemoryRelease | null,
  projectRelease: CurrentVerifiedMemoryRelease | null,
  maxTokens: number,
): { global?: string; project?: string } {
  if (maxTokens <= 0) return {};
  if (globalRelease && !projectRelease) {
    return { global: truncateToTokenBudget(globalRelease.profile, maxTokens) };
  }
  if (projectRelease && !globalRelease) {
    return { project: truncateToTokenBudget(projectRelease.profile, maxTokens) };
  }
  if (!globalRelease || !projectRelease) return {};

  const globalNeed = estimateTokens(globalRelease.profile);
  const projectNeed = estimateTokens(projectRelease.profile);
  let globalBudget = Math.floor(maxTokens / 2);
  let projectBudget = maxTokens - globalBudget;
  if (globalNeed < globalBudget) {
    projectBudget += globalBudget - globalNeed;
    globalBudget = globalNeed;
  }
  if (projectNeed < projectBudget) {
    globalBudget += projectBudget - projectNeed;
    projectBudget = projectNeed;
  }

  return {
    global: truncateToTokenBudget(globalRelease.profile, globalBudget),
    project: truncateToTokenBudget(projectRelease.profile, projectBudget),
  };
}

function truncateToTokenBudget(content: string, maxTokens: number): string {
  const normalized = content.trim();
  if (estimateTokens(normalized) <= maxTokens) return normalized;

  const marker = "\n\n[Profile truncated to the configured memory budget.]";
  const markerTokens = estimateTokens(marker);
  const contentBudget = Math.max(0, maxTokens - markerTokens);
  let used = 0;
  let output = "";
  for (const character of normalized) {
    const cost = characterTokenCost(character);
    if (used + cost > contentBudget) break;
    output += character;
    used += cost;
  }
  return `${output.trimEnd()}${maxTokens >= markerTokens ? marker : ""}`.trim();
}

function normalizeTokenBudget(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_PROFILE_MAX_TOKENS;
  return Math.max(0, Math.min(100_000, Math.floor(value)));
}

function estimateTokens(content: string): number {
  let tokens = 0;
  for (const character of content) tokens += characterTokenCost(character);
  return Math.ceil(tokens);
}

function characterTokenCost(character: string): number {
  const code = character.codePointAt(0) ?? 0;
  return (
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x3000 && code <= 0x303f) ||
    (code >= 0xff00 && code <= 0xffef)
  ) ? 1.5 : 0.25;
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function isSafeReleaseId(value: unknown): value is string {
  return typeof value === "string" && RELEASE_ID_PATTERN.test(value);
}

function isNullableSafeReleaseId(value: unknown): boolean {
  return value === null || isSafeReleaseId(value);
}

function isSafeReleaseRelativePath(value: string): boolean {
  if (
    !value ||
    value.includes("\\") ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("\0")
  ) {
    return false;
  }
  const segments = value.split("/");
  return segments.every((segment) =>
    segment.length > 0 && segment !== "." && segment !== "..");
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
