// Deterministic project scanner — the repository half of file memory.
//
// This module answers "what is objectively true about this checkout right now"
// by reading committed files and read-only Git metadata. It never calls a model
// and never infers anything about the user: every fact carries the exact source
// path and a content hash so a later run can prove whether it is still current.
//
// Facts are grouped rather than exploded one-per-dependency. A bounded catalog
// stays greppable; hundreds of near-identical cards do not.

import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { gitExec, isGitRepo } from "../tools/git/advisor.js";
import type { MemoryKind } from "./types.js";

export type ProjectFactSource =
  | "dependencies"
  | "structure"
  | "config"
  | "git_history";

export interface ProjectFact {
  /** Stable address; re-scanning the same checkout must produce the same key. */
  logicalKey: string;
  kind: MemoryKind;
  source: ProjectFactSource;
  /** Repository-relative path, or a read-only Git command, that proves the fact. */
  origin: string;
  title: string;
  body: string;
  tags: string[];
  languages: string[];
  /** SHA-256 over the exact scanned input, used for change detection. */
  contentHash: string;
}

export interface ProjectScanResult {
  facts: ProjectFact[];
  warnings: string[];
  breakdown: Record<ProjectFactSource, number>;
}

export interface ProjectScanOptions {
  /** Recent commits to summarize. Bounded so history cannot flood the catalog. */
  maxCommits?: number;
  /** Upper bound on entries listed inside any single grouped fact. */
  maxEntriesPerFact?: number;
}

const DEFAULT_MAX_COMMITS = 20;
const DEFAULT_MAX_ENTRIES = 40;
const MAX_BODY_CHARS = 1_500;

const CONFIG_FILES = [
  ".editorconfig",
  ".eslintrc",
  ".eslintrc.cjs",
  ".eslintrc.json",
  ".gitignore",
  ".npmrc",
  ".nvmrc",
  ".prettierrc",
  ".rubato.yml",
  "AGENTS.md",
  "CLAUDE.md",
  "Cargo.toml",
  "Dockerfile",
  "Makefile",
  "biome.json",
  "docker-compose.yml",
  "eslint.config.js",
  "go.mod",
  "pyproject.toml",
  "requirements.txt",
  "tsconfig.json",
  "vitest.config.ts",
] as const;

const FRAMEWORK_SIGNALS: ReadonlyArray<[string, string]> = [
  ["next", "Next.js"],
  ["react", "React"],
  ["vue", "Vue"],
  ["svelte", "Svelte"],
  ["@angular/core", "Angular"],
  ["express", "Express"],
  ["fastify", "Fastify"],
  ["nestjs", "NestJS"],
  ["@nestjs/core", "NestJS"],
  ["vitest", "Vitest"],
  ["jest", "Jest"],
  ["mocha", "Mocha"],
  ["playwright", "Playwright"],
  ["@playwright/test", "Playwright"],
  ["typescript", "TypeScript"],
  ["esbuild", "esbuild"],
  ["vite", "Vite"],
  ["webpack", "webpack"],
  ["rollup", "Rollup"],
  ["prisma", "Prisma"],
  ["drizzle-orm", "Drizzle"],
  ["better-sqlite3", "SQLite"],
  ["pg", "PostgreSQL"],
  ["mongoose", "MongoDB"],
];

const LANGUAGE_EXTENSIONS: Readonly<Record<string, string>> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".rs": "rust",
  ".go": "go",
  ".java": "java",
  ".kt": "kotlin",
  ".rb": "ruby",
  ".php": "php",
  ".swift": "swift",
  ".c": "c",
  ".h": "c",
  ".cc": "cpp",
  ".cpp": "cpp",
  ".hpp": "cpp",
  ".cs": "csharp",
  ".sh": "shell",
  ".sql": "sql",
};

const IGNORED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  "target",
  "coverage",
  ".next",
  ".turbo",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
]);

export async function scanProjectFacts(
  workingDir: string,
  options: ProjectScanOptions = {},
): Promise<ProjectScanResult> {
  const facts: ProjectFact[] = [];
  const warnings: string[] = [];
  const limits = {
    maxCommits: boundedInteger(options.maxCommits, DEFAULT_MAX_COMMITS, 1, 200),
    maxEntries: boundedInteger(
      options.maxEntriesPerFact,
      DEFAULT_MAX_ENTRIES,
      1,
      200,
    ),
  };

  for (const scanner of [scanPackage, scanStructure, scanConfig] as const) {
    try {
      facts.push(...scanner(workingDir, limits));
    } catch (error) {
      warnings.push(`${scanner.name}: ${errorText(error)}`);
    }
  }

  try {
    if (await isGitRepo(workingDir)) {
      facts.push(...(await scanGitHistory(workingDir, limits)));
    }
  } catch (error) {
    warnings.push(`scanGitHistory: ${errorText(error)}`);
  }

  const deduped = dedupeByLogicalKey(facts);
  return {
    facts: deduped,
    warnings,
    breakdown: {
      dependencies: countSource(deduped, "dependencies"),
      structure: countSource(deduped, "structure"),
      config: countSource(deduped, "config"),
      git_history: countSource(deduped, "git_history"),
    },
  };
}

interface ScanLimits {
  maxCommits: number;
  maxEntries: number;
}

function scanPackage(workingDir: string, limits: ScanLimits): ProjectFact[] {
  const packagePath = path.join(workingDir, "package.json");
  if (!isReadableFile(packagePath)) return [];
  const raw = fs.readFileSync(packagePath, "utf8");
  const pkg = JSON.parse(raw) as {
    name?: unknown;
    version?: unknown;
    description?: unknown;
    private?: unknown;
    type?: unknown;
    engines?: unknown;
    dependencies?: unknown;
    devDependencies?: unknown;
    optionalDependencies?: unknown;
    peerDependencies?: unknown;
    scripts?: unknown;
  };

  const facts: ProjectFact[] = [];
  const name = stringOrUndefined(pkg.name) ?? path.basename(path.resolve(workingDir));
  const identityLines = [
    `Package name: ${name}`,
    ...(stringOrUndefined(pkg.version) ? [`Version: ${pkg.version as string}`] : []),
    ...(stringOrUndefined(pkg.description)
      ? [`Description: ${pkg.description as string}`]
      : []),
    ...(stringOrUndefined(pkg.type) ? [`Module type: ${pkg.type as string}`] : []),
    ...(pkg.private === true ? ["Private: true"] : []),
    ...formatRecordLines("Engine", pkg.engines, limits.maxEntries),
  ];
  facts.push(makeFact({
    logicalKey: "repo.project.identity",
    kind: "environment",
    source: "dependencies",
    origin: "package.json",
    title: "Project identity",
    lines: identityLines,
    tags: ["package", "identity", name],
  }));

  for (const [field, label, key] of [
    ["dependencies", "Runtime dependencies", "repo.dependencies.runtime"],
    ["devDependencies", "Development dependencies", "repo.dependencies.development"],
    ["optionalDependencies", "Optional dependencies", "repo.dependencies.optional"],
    ["peerDependencies", "Peer dependencies", "repo.dependencies.peer"],
  ] as const) {
    const entries = recordEntries(pkg[field]);
    if (entries.length === 0) continue;
    facts.push(makeFact({
      logicalKey: key,
      kind: "environment",
      source: "dependencies",
      origin: `package.json#${field}`,
      title: label,
      lines: [
        `${entries.length} declared in package.json ${field}.`,
        ...truncateList(
          entries.map(([dep, version]) => `- ${dep}@${version}`),
          limits.maxEntries,
        ),
      ],
      tags: ["dependencies", field],
    }));
  }

  const scripts = recordEntries(pkg.scripts);
  if (scripts.length > 0) {
    facts.push(makeFact({
      logicalKey: "repo.scripts",
      kind: "convention",
      source: "dependencies",
      origin: "package.json#scripts",
      title: "Package scripts",
      lines: [
        "Commands this project defines for build, test, and local development.",
        ...truncateList(
          scripts.map(([script, command]) => `- ${script}: ${command}`),
          limits.maxEntries,
        ),
      ],
      tags: ["scripts", "build", "test"],
    }));
  }

  const frameworks = detectFrameworks(pkg);
  if (frameworks.length > 0) {
    facts.push(makeFact({
      logicalKey: "repo.structure.frameworks",
      kind: "environment",
      source: "structure",
      origin: "package.json#dependencies",
      title: "Frameworks and tooling",
      lines: [
        `Detected from declared dependencies: ${frameworks.join(", ")}.`,
      ],
      tags: ["frameworks", "tooling", ...frameworks.map(lowerSlug)],
    }));
  }

  return facts;
}

function scanStructure(workingDir: string, limits: ScanLimits): ProjectFact[] {
  const facts: ProjectFact[] = [];
  const entries = fs.readdirSync(workingDir, { withFileTypes: true });
  const directories = entries
    .filter((entry) =>
      entry.isDirectory() &&
      !entry.name.startsWith(".") &&
      !IGNORED_DIRECTORIES.has(entry.name))
    .map((entry) => entry.name)
    .sort();

  if (directories.length > 0) {
    facts.push(makeFact({
      logicalKey: "repo.structure.layout",
      kind: "environment",
      source: "structure",
      origin: ".",
      title: "Top-level layout",
      lines: [
        `Top-level source directories: ${
          truncateList(directories, limits.maxEntries).join(", ")
        }.`,
        ...describeSourceSubdirectories(workingDir, directories, limits),
      ],
      tags: ["structure", "layout", ...directories.slice(0, 12)],
    }));
  }

  const languages = detectLanguages(workingDir);
  if (languages.length > 0) {
    facts.push(makeFact({
      logicalKey: "repo.structure.languages",
      kind: "environment",
      source: "structure",
      origin: ".",
      title: "Languages by file count",
      lines: [
        `Ranked by tracked source files: ${
          languages.map(({ language, files }) => `${language} (${files})`).join(", ")
        }.`,
      ],
      tags: ["languages", ...languages.map((item) => item.language)],
      languages: languages.map((item) => item.language),
    }));
  }

  return facts;
}

function scanConfig(workingDir: string, limits: ScanLimits): ProjectFact[] {
  const facts: ProjectFact[] = [];
  const present = CONFIG_FILES
    .filter((file) => isReadableFile(path.join(workingDir, file)))
    .sort();

  if (present.length > 0) {
    facts.push(makeFact({
      logicalKey: "repo.config.files",
      kind: "convention",
      source: "config",
      origin: ".",
      title: "Configuration files present",
      lines: [
        `Config files in the repository root: ${
          truncateList([...present], limits.maxEntries).join(", ")
        }.`,
      ],
      tags: ["config", ...present.map(lowerSlug)],
    }));
  }

  const tsconfigPath = path.join(workingDir, "tsconfig.json");
  if (isReadableFile(tsconfigPath)) {
    try {
      const tsconfig = JSON.parse(stripJsonComments(
        fs.readFileSync(tsconfigPath, "utf8"),
      )) as { compilerOptions?: unknown; include?: unknown; exclude?: unknown };
      const options = recordEntries(tsconfig.compilerOptions)
        .filter(([key]) => TSCONFIG_KEYS.has(key));
      if (options.length > 0) {
        facts.push(makeFact({
          logicalKey: "repo.config.typescript",
          kind: "convention",
          source: "config",
          origin: "tsconfig.json",
          title: "TypeScript compiler settings",
          lines: [
            "Compiler options that constrain how code in this repository must be written.",
            ...options.map(([key, value]) => `- ${key}: ${value}`),
          ],
          tags: ["typescript", "tsconfig", "config"],
          languages: ["typescript"],
        }));
      }
    } catch (error) {
      // A malformed tsconfig is the repository's problem, not a memory failure.
      void error;
    }
  }

  return facts;
}

const TSCONFIG_KEYS = new Set([
  "target",
  "module",
  "moduleResolution",
  "strict",
  "noImplicitAny",
  "noUncheckedIndexedAccess",
  "exactOptionalPropertyTypes",
  "esModuleInterop",
  "verbatimModuleSyntax",
  "jsx",
  "outDir",
  "rootDir",
  "lib",
]);

async function scanGitHistory(
  workingDir: string,
  limits: ScanLimits,
): Promise<ProjectFact[]> {
  const facts: ProjectFact[] = [];

  const remote = await safeGit(["remote", "get-url", "origin"], workingDir);
  if (remote) {
    facts.push(makeFact({
      logicalKey: "repo.git.remote",
      kind: "environment",
      source: "git_history",
      origin: "git remote get-url origin",
      title: "Git remote",
      lines: [`origin: ${redactUrlCredentials(remote)}`],
      tags: ["git", "remote"],
    }));
  }

  const defaultBranch = await detectDefaultBranch(workingDir);
  if (defaultBranch) {
    facts.push(makeFact({
      logicalKey: "repo.git.default_branch",
      kind: "convention",
      source: "git_history",
      origin: "git symbolic-ref refs/remotes/origin/HEAD",
      title: "Default branch",
      lines: [`Integration branch: ${defaultBranch}`],
      tags: ["git", "branch", defaultBranch],
    }));
  }

  // %s only: commit subjects describe the work, while author names and emails
  // are personal data that repository facts have no reason to retain.
  const log = await safeGit(
    ["log", `-${limits.maxCommits}`, "--no-merges", "--pretty=format:%s"],
    workingDir,
  );
  const subjects = (log ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (subjects.length > 0) {
    facts.push(makeFact({
      logicalKey: "repo.git.recent_work",
      kind: "note",
      source: "git_history",
      origin: `git log -${limits.maxCommits} --pretty=format:%s`,
      title: "Recent commit subjects",
      lines: [
        `The ${subjects.length} most recent non-merge commit subjects, newest first.`,
        ...truncateList(
          subjects.map((subject) => `- ${subject}`),
          limits.maxEntries,
        ),
      ],
      tags: ["git", "history", "commits"],
    }));

    const convention = detectCommitConvention(subjects);
    if (convention) {
      facts.push(makeFact({
        logicalKey: "repo.git.commit_convention",
        kind: "convention",
        source: "git_history",
        origin: `git log -${limits.maxCommits} --pretty=format:%s`,
        title: "Commit message convention",
        lines: [convention],
        tags: ["git", "commit", "convention"],
      }));
    }
  }

  return facts;
}

// ---- Detection helpers ----

function detectFrameworks(pkg: {
  dependencies?: unknown;
  devDependencies?: unknown;
}): string[] {
  const declared = new Set([
    ...recordEntries(pkg.dependencies).map(([name]) => name),
    ...recordEntries(pkg.devDependencies).map(([name]) => name),
  ]);
  const found = new Set<string>();
  for (const [dependency, label] of FRAMEWORK_SIGNALS) {
    if (declared.has(dependency)) found.add(label);
  }
  return [...found].sort();
}

function detectLanguages(
  workingDir: string,
): Array<{ language: string; files: number }> {
  const counts = new Map<string, number>();
  let visited = 0;

  const visit = (directory: string, depth: number): void => {
    if (depth > 6 || visited > 4_000) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (visited > 4_000) return;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || IGNORED_DIRECTORIES.has(entry.name)) {
          continue;
        }
        visit(path.join(directory, entry.name), depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      visited++;
      const language = LANGUAGE_EXTENSIONS[path.extname(entry.name).toLowerCase()];
      if (language) counts.set(language, (counts.get(language) ?? 0) + 1);
    }
  };

  visit(workingDir, 0);
  return [...counts.entries()]
    .map(([language, files]) => ({ language, files }))
    .sort((left, right) =>
      right.files - left.files || left.language.localeCompare(right.language))
    .slice(0, 8);
}

function describeSourceSubdirectories(
  workingDir: string,
  directories: string[],
  limits: ScanLimits,
): string[] {
  const sourceRoot = ["src", "lib", "app", "packages"]
    .find((candidate) => directories.includes(candidate));
  if (!sourceRoot) return [];
  try {
    const children = fs
      .readdirSync(path.join(workingDir, sourceRoot), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .sort();
    if (children.length === 0) return [];
    return [
      `Modules under ${sourceRoot}/: ${
        truncateList(children, limits.maxEntries).join(", ")
      }.`,
    ];
  } catch {
    return [];
  }
}

function detectCommitConvention(subjects: string[]): string | null {
  const conventional = subjects.filter((subject) =>
    /^(?:build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)(?:\([^)]+\))?!?:\s/
      .test(subject)).length;
  const ratio = conventional / subjects.length;
  if (ratio >= 0.6) {
    return `${conventional} of the ${subjects.length} most recent commits use ` +
      "Conventional Commits (`type(scope): subject`). Match this style.";
  }
  const capitalizedImperative = subjects.filter((subject) =>
    /^[A-Z][a-z]+\s/.test(subject) && !subject.endsWith(".")).length;
  if (capitalizedImperative / subjects.length >= 0.6) {
    return `${capitalizedImperative} of the ${subjects.length} most recent ` +
      "commits use short capitalized imperative subjects without a trailing period.";
  }
  return null;
}

async function detectDefaultBranch(workingDir: string): Promise<string | null> {
  const symbolic = await safeGit(
    ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    workingDir,
  );
  if (symbolic) {
    const short = symbolic.replace(/^origin\//, "").trim();
    if (isSafeBranchName(short)) return short;
  }
  for (const candidate of ["main", "master"]) {
    const exists = await safeGit(
      ["rev-parse", "--verify", "--quiet", `refs/heads/${candidate}`],
      workingDir,
    );
    if (exists) return candidate;
  }
  return null;
}

// ---- Fact construction ----

interface MakeFactInput {
  logicalKey: string;
  kind: MemoryKind;
  source: ProjectFactSource;
  origin: string;
  title: string;
  lines: string[];
  tags: string[];
  languages?: string[];
}

function makeFact(input: MakeFactInput): ProjectFact {
  const body = clampBody(input.lines.filter(Boolean).join("\n"));
  return {
    logicalKey: input.logicalKey,
    kind: input.kind,
    source: input.source,
    origin: input.origin,
    title: input.title,
    body,
    tags: normalizeTags([...input.tags, "repository", input.source]),
    languages: [...new Set(input.languages ?? [])].sort(),
    contentHash: createHash("sha256")
      .update(`${input.logicalKey}\u0000${input.origin}\u0000${body}`)
      .digest("hex"),
  };
}

function clampBody(body: string): string {
  const normalized = body.trim();
  if (normalized.length <= MAX_BODY_CHARS) return normalized;
  return `${normalized.slice(0, MAX_BODY_CHARS - 1).trimEnd()}…`;
}

function normalizeTags(tags: string[]): string[] {
  return [...new Set(tags.map(lowerSlug).filter(Boolean))].sort().slice(0, 20);
}

function lowerSlug(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/[^a-z0-9._/-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function dedupeByLogicalKey(facts: ProjectFact[]): ProjectFact[] {
  const byKey = new Map<string, ProjectFact>();
  for (const fact of facts) {
    if (!byKey.has(fact.logicalKey)) byKey.set(fact.logicalKey, fact);
  }
  return [...byKey.values()].sort((left, right) =>
    left.logicalKey.localeCompare(right.logicalKey));
}

function countSource(facts: ProjectFact[], source: ProjectFactSource): number {
  return facts.filter((fact) => fact.source === source).length;
}

// ---- Small utilities ----

async function safeGit(args: string[], cwd: string): Promise<string | null> {
  try {
    const output = (await gitExec(args, cwd)).trim();
    return output || null;
  } catch {
    return null;
  }
}

function isReadableFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function recordEntries(value: unknown): Array<[string, string]> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return [];
  }
  return Object.entries(value as Record<string, unknown>)
    .filter(([key]) => key.trim().length > 0)
    .map(([key, item]): [string, string] => [
      key,
      typeof item === "string" ? item : JSON.stringify(item),
    ])
    .sort(([left], [right]) => left.localeCompare(right));
}

function formatRecordLines(
  label: string,
  value: unknown,
  maxEntries: number,
): string[] {
  return truncateList(
    recordEntries(value).map(([key, item]) => `${label} ${key}: ${item}`),
    maxEntries,
  );
}

function truncateList(values: string[], maxEntries: number): string[] {
  if (values.length <= maxEntries) return values;
  return [
    ...values.slice(0, maxEntries),
    `… and ${values.length - maxEntries} more`,
  ];
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stripJsonComments(raw: string): string {
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'\\])\/\/.*$/gm, "$1")
    .replace(/,(\s*[}\]])/g, "$1");
}

/** A remote URL may embed a token; a repository fact must not persist it. */
function redactUrlCredentials(url: string): string {
  return url.replace(/\/\/[^/@\s]+@/, "//<redacted>@");
}

function isSafeBranchName(value: string): boolean {
  return /^[A-Za-z0-9._/-]{1,200}$/.test(value);
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value as number)));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
