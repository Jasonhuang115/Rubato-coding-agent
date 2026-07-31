import { createHash } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FileMemorySource,
  loadCurrentVerifiedMemory,
} from "../src/context/file-memory.js";
import { serializeMemoryCard } from "../src/memory-files/card.js";
import {
  buildCatalog,
  buildMemoryIndex,
  serializeCatalog,
} from "../src/memory-files/catalog.js";
import { resolveMemoryScopePaths } from "../src/memory-files/paths.js";
import {
  loadMemoryPolicy,
  saveMemoryPolicy,
} from "../src/memory-files/policy.js";
import { publishMemoryRelease } from "../src/memory-files/release.js";
import type {
  MemoryCard,
  MemoryScope,
  ReleaseManifest,
} from "../src/memory-files/types.js";
import type { AgentContext } from "../src/shared/core-types.js";

const CREATED_AT = "2026-07-31T00:00:00.000Z";

describe("verified file-memory context", () => {
  let rootDir = "";
  let projectDir = "";

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rubato-file-context-"));
    projectDir = path.join(rootDir, "workspace");
    fs.mkdirSync(projectDir, { recursive: true });
  });

  afterEach(() => {
    makeTreeWritable(rootDir);
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it("injects bounded global then project profiles and advertises exact read-only files", async () => {
    const globalCard = memoryCard("global-pref", "global", "response.detail");
    const projectCard = memoryCard(
      "project-convention",
      "project",
      "project.tests",
    );
    const global = publishRelease({
      rootDir,
      scope: "global",
      releaseId: "global-v1",
      profile: "GLOBAL PROFILE: prefer concise explanations.",
      cards: [globalCard],
    });
    const project = publishRelease({
      rootDir,
      projectDir,
      scope: "project",
      releaseId: "project-v1",
      profile: "PROJECT PROFILE: run focused tests first.",
      cards: [projectCard],
    });

    const source = new FileMemorySource({ rootDir });
    const block = await source.fetch(
      "This query must not be used for top-k retrieval.",
      mockContext(projectDir),
    );

    expect(block).not.toBeNull();
    expect(block).toMatchObject({ source: "file-memory", priority: 15 });
    const content = block!.content;
    expect(content.indexOf("GLOBAL PROFILE")).toBeLessThan(
      content.indexOf("PROJECT PROFILE"),
    );
    expect(content).toMatch(/current request[\s\S]*always take precedence/i);
    expect(content).toContain("No top-k or RAG retrieval was performed");
    expect(content).toContain(`Global catalog: \`${global.catalogPath}\``);
    expect(content).toContain(`Global cards: \`${global.cardsDir}\``);
    expect(content).toContain(`Project catalog: \`${project.catalogPath}\``);
    expect(content).toContain(`Project cards: \`${project.cardsDir}\``);
    expect(path.isAbsolute(global.catalogPath)).toBe(true);
    expect(path.isAbsolute(project.cardsDir)).toBe(true);
  });

  it("loads a release emitted by the canonical publisher API", () => {
    const paths = resolveMemoryScopePaths({ rootDir, scope: "global" });
    const published = publishMemoryRelease(paths, {
      baseReleaseId: null,
      releaseId: "publisher-v1",
      createdAt: CREATED_AT,
      changes: [{
        type: "create",
        card: memoryCard("publisher-card", "global", "response.publisher"),
      }],
    });

    const loaded = loadCurrentVerifiedMemory({ rootDir, scope: "global" });
    expect(loaded).not.toBeNull();
    expect(loaded).toMatchObject({
      releaseId: published.id,
      profile: published.profile,
    });
    expect(loaded!.catalog.map((entry) => entry.id)).toEqual([
      "publisher-card",
    ]);
  });

  it("accepts distinct contextual variants of the same logical key", () => {
    const globalVariant = memoryCard(
      "detail-global",
      "global",
      "communication.explanation_depth",
    );
    globalVariant.body = "concise";
    const architectureVariant = memoryCard(
      "detail-architecture",
      "global",
      "communication.explanation_depth",
    );
    architectureVariant.body = "detailed";
    architectureVariant.contexts.domains = ["architecture"];

    publishRelease({
      rootDir,
      scope: "global",
      releaseId: "contextual-variants",
      profile: "PROFILE",
      cards: [globalVariant, architectureVariant],
    });

    const loaded = loadCurrentVerifiedMemory({ rootDir, scope: "global" });
    expect(loaded?.catalog.map((entry) => entry.id)).toEqual([
      "detail-architecture",
      "detail-global",
    ]);
  });

  it("shares a hard profile budget without dropping the project profile", async () => {
    publishRelease({
      rootDir,
      scope: "global",
      releaseId: "global-large",
      profile: `GLOBAL-${"g".repeat(800)}-GLOBAL-END`,
    });
    publishRelease({
      rootDir,
      projectDir,
      scope: "project",
      releaseId: "project-large",
      profile: `PROJECT-${"p".repeat(800)}-PROJECT-END`,
    });

    const block = await new FileMemorySource({
      rootDir,
      profileMaxTokens: 40,
    }).fetch("ignored", mockContext(projectDir));

    expect(block).not.toBeNull();
    expect(block!.content).toContain("GLOBAL-");
    expect(block!.content).toContain("PROJECT-");
    expect(block!.content).not.toContain("GLOBAL-END");
    expect(block!.content).not.toContain("PROJECT-END");
  });

  it("lets POLICY.yml lower the profile budget a project config asks for", async () => {
    publishRelease({
      rootDir,
      scope: "global",
      releaseId: "policy-cap",
      profile: `GLOBAL-${"g".repeat(1_200)}-GLOBAL-END`,
    });
    const generous = mockContext(projectDir);
    generous.config.memory!.profileMaxTokens = 4_000;

    const uncapped = await new FileMemorySource({ rootDir })
      .fetch("ignored", generous);
    expect(uncapped!.content).toContain("GLOBAL-END");

    // A repository-provided .rubato.yml may not raise what the user allowed.
    const policy = loadMemoryPolicy(rootDir);
    policy.profile_max_tokens = 100;
    saveMemoryPolicy(policy, rootDir);

    const capped = await new FileMemorySource({ rootDir })
      .fetch("ignored", generous);
    expect(capped!.content).toContain("GLOBAL-");
    expect(capped!.content).not.toContain("GLOBAL-END");
    expect(capped!.content).toContain("Profile truncated");
  });

  it("injects repository facts as an addressable index, never as profile text", async () => {
    const fact = repositoryCard("repo.structure.layout");
    publishRelease({
      rootDir,
      projectDir,
      scope: "project",
      releaseId: "repo-facts",
      profile: "PROJECT PROFILE",
      cards: [fact],
    });

    const block = await new FileMemorySource({ rootDir })
      .fetch("ignored", mockContext(projectDir));

    expect(block!.content).toContain("### Project repository facts (index only)");
    expect(block!.content).toContain("`repo.structure.layout`");
    expect(block!.content).toContain(fact.title);
    expect(block!.content).not.toContain(fact.body);
  });

  it("fails closed when CURRENT is absent and never scans old releases or candidates", async () => {
    const old = publishRelease({
      rootDir,
      scope: "global",
      releaseId: "old-release",
      profile: "OLD PROFILE MUST NOT LOAD",
    });
    fs.unlinkSync(old.currentPath);
    const candidateDir = path.join(
      path.dirname(old.currentPath),
      "candidates",
      "candidate-1",
    );
    fs.mkdirSync(candidateDir, { recursive: true });
    fs.writeFileSync(
      path.join(candidateDir, "PROFILE.md"),
      "CANDIDATE PROFILE MUST NOT LOAD",
      "utf8",
    );

    expect(loadCurrentVerifiedMemory({ rootDir, scope: "global" })).toBeNull();
    expect(
      await new FileMemorySource({ rootDir }).fetch(
        "old candidate",
        mockContext(projectDir),
      ),
    ).toBeNull();
  });

  it("omits an invalid current project release without falling back to an older one", async () => {
    publishRelease({
      rootDir,
      scope: "global",
      releaseId: "global-valid",
      profile: "VALID GLOBAL PROFILE",
    });
    publishRelease({
      rootDir,
      projectDir,
      scope: "project",
      releaseId: "project-old",
      profile: "OLD PROJECT PROFILE MUST NOT LOAD",
    });
    const current = publishRelease({
      rootDir,
      projectDir,
      scope: "project",
      releaseId: "project-current",
      profile: "TAMPERED PROJECT PROFILE MUST NOT LOAD",
    });
    fs.appendFileSync(current.profilePath, "\ntampered after publication\n", "utf8");

    expect(loadCurrentVerifiedMemory({
      rootDir,
      projectDir,
      scope: "project",
    })).toBeNull();

    const block = await new FileMemorySource({ rootDir }).fetch(
      "project memory",
      mockContext(projectDir),
    );
    expect(block).not.toBeNull();
    expect(block!.content).toContain("VALID GLOBAL PROFILE");
    expect(block!.content).not.toContain("TAMPERED PROJECT PROFILE");
    expect(block!.content).not.toContain("OLD PROJECT PROFILE");
    expect(block!.content).not.toContain("Project catalog:");
  });

  it("rejects a self-consistently hashed release whose catalog card is invalid", () => {
    const release = publishRelease({
      rootDir,
      scope: "global",
      releaseId: "bad-card-release",
      profile: "PROFILE",
      cards: [memoryCard("preference-1", "global", "response.style")],
    });
    fs.writeFileSync(
      path.join(release.cardsDir, "preference-1.md"),
      "---\nid: preference-1\n---\ninvalid card\n",
      "utf8",
    );
    rewriteManifestHashes(release.releaseDir);

    expect(loadCurrentVerifiedMemory({ rootDir, scope: "global" })).toBeNull();
  });

  it("does not expose a release older than the durable purge ledger", () => {
    publishRelease({
      rootDir,
      scope: "global",
      releaseId: "before-purge",
      profile: "STALE PROFILE MUST NOT LOAD",
    });
    const paths = resolveMemoryScopePaths({ rootDir, scope: "global" });
    fs.mkdirSync(path.dirname(paths.purgeLedgerPath), { recursive: true });
    fs.writeFileSync(
      paths.purgeLedgerPath,
      `${JSON.stringify({
        schemaVersion: 1,
        purgeId: "purge-after-current",
        epoch: 1,
        scope: "global",
        idFingerprints: [],
        logicalKeyFingerprints: [],
        createdAt: CREATED_AT,
      })}\n`,
      "utf8",
    );

    expect(loadCurrentVerifiedMemory({ rootDir, scope: "global" })).toBeNull();
  });

  it("does not inject into subagents or when file memory is disabled", async () => {
    publishRelease({
      rootDir,
      scope: "global",
      releaseId: "global-v1",
      profile: "ROOT ONLY",
    });
    const source = new FileMemorySource({ rootDir });

    expect(await source.fetch("ignored", mockContext(projectDir, 1))).toBeNull();
    const disabled = mockContext(projectDir);
    disabled.config.memory!.enabled = false;
    expect(await source.fetch("ignored", disabled)).toBeNull();
  });
});

interface PublishInput {
  rootDir: string;
  projectDir?: string;
  scope: MemoryScope;
  releaseId: string;
  profile: string;
  cards?: MemoryCard[];
}

interface PublishedPaths {
  releaseDir: string;
  currentPath: string;
  profilePath: string;
  catalogPath: string;
  cardsDir: string;
}

function publishRelease(input: PublishInput): PublishedPaths {
  const paths = resolveMemoryScopePaths({
    rootDir: input.rootDir,
    scope: input.scope,
    projectDir: input.projectDir,
  });
  const releaseDir = path.join(paths.releasesDir, input.releaseId);
  const cardsDir = path.join(releaseDir, "cards");
  fs.mkdirSync(cardsDir, { recursive: true });

  const cards = input.cards ?? [];
  for (const card of cards) {
    fs.writeFileSync(
      path.join(cardsDir, `${card.id}.md`),
      serializeMemoryCard(card),
      "utf8",
    );
  }
  fs.writeFileSync(path.join(releaseDir, "PROFILE.md"), input.profile, "utf8");
  fs.writeFileSync(
    path.join(releaseDir, "INDEX.md"),
    buildMemoryIndex(cards),
    "utf8",
  );
  fs.writeFileSync(
    path.join(releaseDir, "catalog.tsv"),
    serializeCatalog(buildCatalog(cards)),
    "utf8",
  );

  writeManifest(releaseDir, {
    schemaVersion: 1,
    releaseId: input.releaseId,
    parentReleaseId: null,
    scope: input.scope,
    ...(paths.projectId ? { projectId: paths.projectId } : {}),
    createdAt: CREATED_AT,
    purgeEpoch: 0,
    changes: [],
    fileHashes: compiledFileHashes(releaseDir),
  });
  fs.mkdirSync(paths.scopeDir, { recursive: true });
  fs.writeFileSync(paths.currentPath, `${input.releaseId}\n`, "utf8");

  return {
    releaseDir,
    currentPath: paths.currentPath,
    profilePath: path.join(releaseDir, "PROFILE.md"),
    catalogPath: path.join(releaseDir, "catalog.tsv"),
    cardsDir,
  };
}

function writeManifest(
  releaseDir: string,
  manifest: ReleaseManifest,
): void {
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  fs.writeFileSync(path.join(releaseDir, "manifest.json"), serialized, "utf8");
  fs.writeFileSync(
    path.join(releaseDir, "manifest.sha256"),
    `${sha256(Buffer.from(serialized))}\n`,
    "utf8",
  );
}

function rewriteManifestHashes(releaseDir: string): void {
  const manifestPath = path.join(releaseDir, "manifest.json");
  const manifest = JSON.parse(
    fs.readFileSync(manifestPath, "utf8"),
  ) as ReleaseManifest;
  manifest.fileHashes = compiledFileHashes(releaseDir);
  writeManifest(releaseDir, manifest);
}

function compiledFileHashes(releaseDir: string): Record<string, string> {
  const relativeFiles = [
    "PROFILE.md",
    "INDEX.md",
    "catalog.tsv",
    ...fs.readdirSync(path.join(releaseDir, "cards"))
      .sort()
      .map((name) => `cards/${name}`),
  ];
  return Object.fromEntries(relativeFiles.map((relativePath) => [
    relativePath,
    sha256(fs.readFileSync(path.join(releaseDir, ...relativePath.split("/")))),
  ]));
}

function memoryCard(
  id: string,
  scope: MemoryScope,
  logicalKey: string,
): MemoryCard {
  return {
    schemaVersion: 1,
    id,
    revision: 1,
    logicalKey,
    kind: "preference",
    scope,
    status: "active",
    origin: "explicit",
    application: "advisory",
    authority: "user_explicit",
    sensitivity: "normal",
    confidence: 0.9,
    supportScore: 8,
    oppositionScore: 0,
    halfLifeDays: null,
    title: `${id} title`,
    body: `${id} body`,
    conditions: [],
    exceptions: [],
    aliases: [],
    tags: [],
    contexts: {
      domains: [],
      projects: [],
      surfaces: [],
      languages: [],
    },
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    firstSeenAt: CREATED_AT,
    lastSeenAt: CREATED_AT,
    evidence: [{
      sessionId: "session-context",
      eventSeq: 1,
      eventHash: "e".repeat(64),
      actor: "user",
      signal: "explicit_preference",
    }],
    supersedes: [],
    conflicts: [],
  };
}

/** Mirrors what project bootstrap publishes: derived, reference-only, scanned. */
function repositoryCard(logicalKey: string): MemoryCard {
  const card = memoryCard(logicalKey.replace(/[^a-zA-Z0-9._-]+/g, "_"), "project", logicalKey);
  card.kind = "environment";
  card.origin = "derived";
  card.application = "reference";
  card.authority = "repository";
  card.title = "Top-level layout";
  card.body = "Top-level source directories: src, test.";
  card.evidence = [{
    sessionId: "repository:project-1",
    eventSeq: 0,
    eventHash: "f".repeat(64),
    actor: "repository",
    signal: "scan:structure",
  }];
  return card;
}

function mockContext(workingDir: string, depth = 0): AgentContext {
  return {
    workingDir,
    sessionId: "session-1",
    readGuard: {
      hasRead: () => false,
      markAsRead: () => {},
      serialize: () => ({ files: {} }),
    },
    permissionManager: {
      check: () => ({ allowed: true }),
    },
    config: {
      model: { provider: "test", model: "test-model" },
      permissions: {
        bash: "auto",
        read: "auto",
        write: "auto",
        edit: "auto",
        web: "auto",
      },
      memory: {
        enabled: true,
        learningEnabled: true,
        profileMaxTokens: 1_000,
        dreamSessionThreshold: 5,
        dreamCandidateThreshold: 20,
        dreamMaxAgeHours: 24,
        autoPublishExplicitLowRisk: true,
        utilityLearningRate: 0.2,
        utilityMinUses: 5,
      },
      session: { cleanupPeriodDays: 30 },
    },
    depth,
  };
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function makeTreeWritable(directory: string): void {
  if (!fs.existsSync(directory)) return;
  fs.chmodSync(directory, 0o700);
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) makeTreeWritable(entryPath);
    else fs.chmodSync(entryPath, 0o600);
  }
}
