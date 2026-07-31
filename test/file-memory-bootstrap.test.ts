import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  auditProjectFacts,
  bootstrapProjectMemory,
  looksLikeProject,
} from "../src/memory-files/bootstrap.js";
import { scanProjectFacts } from "../src/memory-files/project-scan.js";
import { buildUserProfile } from "../src/memory-files/catalog.js";
import { setMemoryLearningEnabled } from "../src/memory-files/policy.js";
import { FileMemoryRepository } from "../src/memory-files/repository.js";
import {
  publishMemoryRelease,
  readCurrentRelease,
  readCurrentReleaseId,
} from "../src/memory-files/release.js";
import type { MemoryCard } from "../src/memory-files/types.js";

describe("project bootstrap into repository-authored memory", () => {
  let rootDir = "";
  let project = "";
  let previousRubatoHome: string | undefined;

  beforeEach(() => {
    previousRubatoHome = process.env.RUBATO_HOME;
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rubato-bootstrap-"));
    project = path.join(rootDir, "project");
    fs.mkdirSync(project);
    process.env.RUBATO_HOME = rootDir;
    writeProjectFixture(project);
  });

  afterEach(() => {
    if (previousRubatoHome === undefined) delete process.env.RUBATO_HOME;
    else process.env.RUBATO_HOME = previousRubatoHome;
    makeTreeWritable(rootDir);
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it("scans structure, config, dependencies, and Git history deterministically", async () => {
    initGitRepo(project);
    const first = await scanProjectFacts(project);
    const second = await scanProjectFacts(project);

    expect(first.facts).toEqual(second.facts);
    expect(first.warnings).toEqual([]);
    expect(first.breakdown).toMatchObject({
      dependencies: expect.any(Number),
      structure: expect.any(Number),
      config: expect.any(Number),
      git_history: expect.any(Number),
    });

    const byKey = new Map(first.facts.map((fact) => [fact.logicalKey, fact]));
    expect(byKey.get("repo.project.identity")?.body)
      .toContain("Package name: fixture-app");
    expect(byKey.get("repo.dependencies.runtime")?.body).toContain("chalk@^5.3.0");
    expect(byKey.get("repo.scripts")?.body).toContain("build: tsc");
    expect(byKey.get("repo.structure.layout")?.body).toContain("src");
    expect(byKey.get("repo.structure.layout")?.body).toContain("Modules under src/");
    expect(byKey.get("repo.structure.languages")?.body).toContain("typescript");
    expect(byKey.get("repo.config.files")?.body).toContain("tsconfig.json");
    expect(byKey.get("repo.config.typescript")?.body).toContain("strict: true");
    expect(byKey.get("repo.structure.frameworks")?.body).toContain("TypeScript");
    expect(byKey.get("repo.git.recent_work")?.body).toContain("feat: add scanner");
    expect(byKey.get("repo.git.commit_convention")?.body)
      .toContain("Conventional Commits");

    // node_modules and dist must not leak into the language census.
    expect(byKey.get("repo.structure.languages")?.body).not.toContain("python");
  });

  it("publishes repository cards that cannot pose as user beliefs", async () => {
    const result = await bootstrapProjectMemory({ workingDir: project, rootDir });

    expect(result.scanned).toBeGreaterThan(3);
    expect(result.created).toContain("repo.project.identity");
    expect(result.releaseId).toBeTruthy();
    expect(result.skipped).toEqual([]);

    const repository = new FileMemoryRepository({ rootDir, projectDir: project });
    const current = readCurrentRelease(repository.projectPaths);
    const identity = current?.cards
      .find((card) => card.logicalKey === "repo.project.identity");
    expect(identity).toMatchObject({
      authority: "repository",
      origin: "derived",
      application: "reference",
      status: "active",
      scope: "project",
    });
    expect(identity?.evidence).toEqual([
      expect.objectContaining({
        actor: "repository",
        sessionId: `repository:${repository.projectId}`,
        signal: "scan:dependencies",
      }),
    ]);
    // Evidence hash is the content hash, so staleness is provable later.
    expect(identity?.evidence[0].eventHash).toMatch(/^[a-f0-9]{64}$/);
    expect(identity?.reviewAfter).toBeTruthy();

    // No observation or candidate was created: this is not user learning.
    expect(repository.listObservations("project")).toEqual([]);
    expect(repository.listCandidates("pending", "project")).toEqual([]);
  });

  it("keeps repository facts out of the always-injected user profile", async () => {
    await bootstrapProjectMemory({ workingDir: project, rootDir });
    const repository = new FileMemoryRepository({ rootDir, projectDir: project });
    const current = readCurrentRelease(repository.projectPaths);

    expect(current!.cards.some((card) => card.kind === "environment")).toBe(true);
    expect(current!.profile).not.toContain("repo.project.identity");
    expect(buildUserProfile(current!.cards)).toContain("_No active profile memories._");
  });

  it("is idempotent and republishes only what the checkout changed", async () => {
    const first = await bootstrapProjectMemory({ workingDir: project, rootDir });
    const repository = new FileMemoryRepository({ rootDir, projectDir: project });
    const afterFirst = readCurrentReleaseId(repository.projectPaths);

    const second = await bootstrapProjectMemory({ workingDir: project, rootDir });
    expect(second.created).toEqual([]);
    expect(second.revised).toEqual([]);
    expect(second.retired).toEqual([]);
    expect(second.unchanged).toBe(first.created.length);
    expect(second.releaseId).toBeUndefined();
    expect(readCurrentReleaseId(repository.projectPaths)).toBe(afterFirst);

    fs.writeFileSync(
      path.join(project, "package.json"),
      JSON.stringify({
        name: "fixture-app",
        version: "2.0.0",
        dependencies: { chalk: "^5.3.0" },
        scripts: { build: "tsc" },
      }, null, 2),
    );
    const third = await bootstrapProjectMemory({ workingDir: project, rootDir });
    expect(third.revised).toContain("repo.project.identity");
    expect(third.retired).toContain("repo.dependencies.development");
    expect(readCurrentReleaseId(repository.projectPaths)).not.toBe(afterFirst);

    const identity = readCurrentRelease(repository.projectPaths)?.cards
      .find((card) => card.logicalKey === "repo.project.identity");
    expect(identity?.revision).toBe(2);
    expect(identity?.body).toContain("Version: 2.0.0");
  });

  it("preserves user cards published in the same scope", async () => {
    const repository = new FileMemoryRepository({ rootDir, projectDir: project });
    publishMemoryRelease(repository.projectPaths, {
      baseReleaseId: null,
      changes: [{ type: "create", card: userCard() }],
      reason: "fixture",
    });

    await bootstrapProjectMemory({ workingDir: project, rootDir });
    const cards = readCurrentRelease(repository.projectPaths)?.cards ?? [];
    expect(cards.some((card) => card.logicalKey === "communication.language"))
      .toBe(true);
    expect(cards.some((card) => card.authority === "repository")).toBe(true);

    // A later pass must not retire the user's card as an unscanned fact.
    const second = await bootstrapProjectMemory({ workingDir: project, rootDir });
    expect(second.retired).toEqual([]);
    expect(readCurrentRelease(repository.projectPaths)?.cards
      .some((card) => card.logicalKey === "communication.language")).toBe(true);
  });

  it("refuses to scan when learning is paused or memory is disabled", async () => {
    const disabled = await bootstrapProjectMemory({
      workingDir: project,
      rootDir,
      enabled: false,
    });
    expect(disabled.warnings).toEqual(["memory_disabled"]);
    expect(disabled.scanned).toBe(0);

    setMemoryLearningEnabled(false, rootDir);
    const paused = await bootstrapProjectMemory({ workingDir: project, rootDir });
    expect(paused.warnings).toEqual(["memory_learning_paused"]);
    expect(paused.scanned).toBe(0);

    const repository = new FileMemoryRepository({ rootDir, projectDir: project });
    expect(readCurrentReleaseId(repository.projectPaths)).toBeNull();
  });

  it("redacts credentials embedded in a remote URL", async () => {
    initGitRepo(project);
    execFileSync("git", [
      "remote",
      "set-url",
      "origin",
      "https://user:ghp_abcdefghijklmnopqrstuvwxyz012345@example.com/a/b.git",
    ], { cwd: project });

    const scan = await scanProjectFacts(project);
    const remote = scan.facts.find((fact) => fact.logicalKey === "repo.git.remote");
    expect(remote?.body).toContain("<redacted>@example.com");
    expect(remote?.body).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz012345");
  });

  it("audits the checkout without writing a release", async () => {
    await bootstrapProjectMemory({ workingDir: project, rootDir });
    const repository = new FileMemoryRepository({ rootDir, projectDir: project });
    const before = readCurrentReleaseId(repository.projectPaths);

    const clean = await auditProjectFacts({ workingDir: project, rootDir });
    expect(clean.stale).toEqual([]);
    expect(clean.missing).toEqual([]);
    expect(clean.orphaned).toEqual([]);
    expect(clean.matched).toBeGreaterThan(0);

    fs.rmSync(path.join(project, "tsconfig.json"));
    const stale = await auditProjectFacts({ workingDir: project, rootDir });
    expect(stale.orphaned).toContain("repo.config.typescript");
    expect(stale.stale).toContain("repo.config.files");
    expect(readCurrentReleaseId(repository.projectPaths)).toBe(before);
  });

  it("recognizes only directories that look like real projects", () => {
    expect(looksLikeProject(project)).toBe(true);
    const empty = path.join(rootDir, "empty");
    fs.mkdirSync(empty);
    expect(looksLikeProject(empty)).toBe(false);
  });
});

function writeProjectFixture(project: string): void {
  fs.writeFileSync(
    path.join(project, "package.json"),
    JSON.stringify({
      name: "fixture-app",
      version: "1.0.0",
      description: "A fixture",
      type: "module",
      dependencies: { chalk: "^5.3.0" },
      devDependencies: { typescript: "^5.6.0" },
      scripts: { build: "tsc", test: "vitest run" },
    }, null, 2),
  );
  fs.writeFileSync(
    path.join(project, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { strict: true, target: "ES2022" } }, null, 2),
  );
  // A second config file keeps `repo.config.files` observable when tsconfig.json
  // is deleted, which is what separates a stale fact from an orphaned card.
  fs.writeFileSync(path.join(project, ".gitignore"), "node_modules/\ndist/\n");
  fs.mkdirSync(path.join(project, "src", "core"), { recursive: true });
  fs.writeFileSync(path.join(project, "src", "index.ts"), "export const a = 1;\n");
  fs.writeFileSync(path.join(project, "src", "core", "run.ts"), "export const b = 2;\n");

  // Ignored trees must not influence the language census or the layout fact.
  fs.mkdirSync(path.join(project, "node_modules", "left-pad"), { recursive: true });
  fs.writeFileSync(
    path.join(project, "node_modules", "left-pad", "index.py"),
    "print(1)\n",
  );
  fs.mkdirSync(path.join(project, "dist"), { recursive: true });
  fs.writeFileSync(path.join(project, "dist", "index.py"), "print(2)\n");
}

function initGitRepo(project: string): void {
  const run = (...args: string[]) =>
    execFileSync("git", args, { cwd: project, stdio: "pipe" });
  run("init", "-q");
  run("config", "user.email", "fixture@example.com");
  run("config", "user.name", "Fixture");
  run("config", "commit.gpgsign", "false");
  run("checkout", "-q", "-b", "main");
  run("remote", "add", "origin", "https://example.com/a/b.git");
  run("add", ".");
  run("commit", "-q", "-m", "feat: add scanner");
  fs.appendFileSync(path.join(project, "src", "index.ts"), "export const c = 3;\n");
  run("add", ".");
  run("commit", "-q", "-m", "fix: handle empty input");
}

function userCard(): MemoryCard {
  const now = "2026-07-31T00:00:00.000Z";
  return {
    schemaVersion: 1,
    id: "communication.language",
    revision: 1,
    logicalKey: "communication.language",
    kind: "preference",
    scope: "project",
    status: "confirmed",
    origin: "explicit",
    application: "automatic",
    authority: "user_explicit",
    sensitivity: "normal",
    confidence: 0.95,
    supportScore: 3,
    oppositionScore: 0,
    halfLifeDays: null,
    title: "Answer language",
    body: "zh",
    conditions: [],
    exceptions: [],
    aliases: [],
    tags: [],
    contexts: { domains: [], projects: [], surfaces: [], languages: [] },
    createdAt: now,
    updatedAt: now,
    firstSeenAt: now,
    lastSeenAt: now,
    evidence: [{
      sessionId: "session-1",
      eventSeq: 1,
      eventHash: "a".repeat(64),
      actor: "user",
      signal: "explicit_preference",
    }],
    supersedes: [],
    conflicts: [],
  };
}

function makeTreeWritable(directory: string): void {
  if (!fs.existsSync(directory)) return;
  try {
    fs.chmodSync(directory, 0o700);
  } catch {
    // Best-effort cleanup.
  }
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    try {
      if (entry.isDirectory()) makeTreeWritable(entryPath);
      else fs.chmodSync(entryPath, 0o600);
    } catch {
      // Best-effort cleanup for immutable release fixtures.
    }
  }
}
