import { createHash } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  hardPurgeMemories,
  previewHardPurge,
} from "../src/memory-files/hard-purge.js";
import { projectMemoryId, resolveMemoryScopePaths } from "../src/memory-files/paths.js";
import {
  isMemorySessionPurged,
  publishMemoryRelease,
  readCurrentRelease,
  readCurrentReleaseId,
  rollbackMemoryRelease,
  verifyRelease,
} from "../src/memory-files/release.js";
import type {
  MemoryCard,
  MemoryScopePaths,
} from "../src/memory-files/types.js";

describe("file-memory hard purge", () => {
  let rootDir = "";
  let workdir = "";
  let paths: MemoryScopePaths;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rubato-hard-purge-"));
    workdir = path.join(rootDir, "workspace");
    fs.mkdirSync(workdir);
    paths = resolveMemoryScopePaths({
      rootDir,
      scope: "project",
      projectDir: workdir,
    });
  });

  afterEach(() => {
    makeTreeWritable(rootDir);
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it("previews every managed copy without exposing targets or mutating storage", () => {
    const fixture = buildCompleteFixture(rootDir, workdir, paths);
    const plan = previewHardPurge({
      memoryRoot: rootDir,
      workdir,
      scope: "project",
      targets: {
        ids: [fixture.privateCard.id],
        logicalKeys: [fixture.privateCard.logicalKey],
        values: [fixture.secret],
      },
    });

    expect(new Set(plan.locations.map((item) => item.category))).toEqual(
      new Set([
        "current_release",
        "release",
        "observation",
        "candidate",
        "dream",
        "session",
        "session_summary",
        "session_catalog",
        "access",
        "outcome",
        "derived_skill",
      ]),
    );
    expect(plan.locations.every((item) => path.isAbsolute(item.path))).toBe(true);
    expect(JSON.stringify(plan)).not.toContain(fixture.privateCard.id);
    expect(JSON.stringify(plan)).not.toContain(fixture.privateCard.logicalKey);
    expect(JSON.stringify(plan)).not.toContain(fixture.secret);
    expect(plan.fingerprints.ids).toHaveLength(1);
    expect(plan.fingerprints.logicalKeys).toHaveLength(1);
    expect(plan.fingerprints.values).toHaveLength(1);

    expect(readCurrentReleaseId(paths)).toBe("rel_private");
    expect(fs.existsSync(fixture.privateCandidate)).toBe(true);
    expect(fs.existsSync(fixture.privateDream)).toBe(true);
    expect(fs.existsSync(fixture.privateSession)).toBe(true);
    expect(fs.existsSync(paths.purgeLedgerPath)).toBe(false);
  });

  it("physically erases derived copies, rewrites chains, and cannot resurrect on rollback", () => {
    const fixture = buildCompleteFixture(rootDir, workdir, paths);
    const result = hardPurgeMemories({
      memoryRoot: path.join(rootDir, "memory"),
      workdir,
      scope: "project",
      intent: "forget",
      baseReleaseId: "rel_private",
      releaseId: "rel_purged",
      createdAt: "2026-07-31T03:00:00.000Z",
      targets: {
        ids: [fixture.privateCard.id],
        logicalKeys: [fixture.privateCard.logicalKey],
        values: [fixture.secret],
      },
    });

    expect(result).toMatchObject({
      releaseId: "rel_purged",
      complete: true,
      residuals: [],
      postScanMatches: [],
    });
    expect(readCurrentRelease(paths)?.cards.map((card) => card.id))
      .toEqual([fixture.safeCard.id]);
    expect(verifyRelease(paths, "rel_purged")).toMatchObject({
      valid: true,
      errors: [],
    });

    expect(fs.existsSync(path.join(paths.releasesDir, "rel_private")))
      .toBe(false);
    expect(fs.existsSync(path.join(paths.releasesDir, "rel_safe"))).toBe(true);
    expect(fs.existsSync(fixture.privateCandidate)).toBe(false);
    expect(fs.existsSync(fixture.privateDream)).toBe(false);
    expect(fs.existsSync(fixture.privateSession)).toBe(false);
    expect(fs.existsSync(fixture.truncatedSession)).toBe(true);
    expect(fs.existsSync(fixture.slugSession)).toBe(true);
    expect(fs.existsSync(fixture.globalDerivedSkill)).toBe(false);
    expect(fs.existsSync(fixture.projectDerivedSkill)).toBe(false);

    expect(fs.readFileSync(fixture.observationPath, "utf8"))
      .toContain("safe observation");
    expect(fs.readFileSync(fixture.accessPath, "utf8"))
      .toContain(fixture.safeCard.id);
    expect(fs.readFileSync(fixture.summaryPath, "utf8"))
      .toContain("safe-session");
    expect(fs.readFileSync(fixture.catalogPath, "utf8"))
      .toContain("safe-session");
    expect(fs.readFileSync(fixture.outcomePath, "utf8"))
      .toContain(fixture.safeCard.id);

    for (const target of [
      fixture.privateCard.id,
      fixture.privateCard.logicalKey,
      fixture.secret,
    ]) {
      expect(findLiteralMatches([
        paths.scopeDir,
        path.join(rootDir, "projects", projectMemoryId(workdir)),
        path.join(rootDir, "skills"),
        path.join(workdir, ".rubato", "skills"),
        fixture.accessPath,
        fixture.outcomePath,
      ], target, new Set([paths.purgeLedgerPath]))).toEqual([]);
    }

    const ledger = fs.readFileSync(paths.purgeLedgerPath, "utf8");
    expect(ledger).not.toContain(fixture.privateCard.id);
    expect(ledger).not.toContain(fixture.privateCard.logicalKey);
    expect(ledger).not.toContain(fixture.secret);
    expect(ledger).toContain("idFingerprints");
    expect(ledger).toContain("logicalKeyFingerprints");
    expect(ledger).toContain("valueFingerprints");
    expect(ledger).toContain("valueFingerprintLengths");
    expect(ledger).toContain("sessionIdFingerprints");
    expect(isMemorySessionPurged(
      rootDir,
      "private-session",
      projectMemoryId(workdir),
    )).toBe(true);
    expect(isMemorySessionPurged(
      rootDir,
      "safe-session",
      projectMemoryId(workdir),
    )).toBe(false);

    expect(() => rollbackMemoryRelease(paths, {
      baseReleaseId: "rel_purged",
      targetReleaseId: "rel_private",
      releaseId: "rel_forbidden_rollback",
    })).toThrow(/missing its manifest/i);
    expect(readCurrentReleaseId(paths)).toBe("rel_purged");
    expect(() => publishMemoryRelease(paths, {
      baseReleaseId: "rel_purged",
      releaseId: "rel_forbidden_recreate",
      changes: [{ type: "create", card: fixture.privateCard }],
    })).toThrow(/blocked by the purge ledger/i);
    expect(() => publishMemoryRelease(paths, {
      baseReleaseId: "rel_purged",
      releaseId: "rel_forbidden_value_recreate",
      changes: [{
        type: "create",
        card: makeCard({
          id: "pref_new_identity",
          logicalKey: "identity.new-private-detail",
          body: `A new wrapper still contains ${fixture.secret.toLowerCase()} here.`,
          evidence: [{
            sessionId: "different-session",
            eventSeq: 1,
            eventHash: "sha256:different",
            actor: "user",
            signal: "explicit_private_detail",
            excerpt: "A distinct piece of evidence.",
          }],
        }),
      }],
    })).toThrow(/blocked by the purge ledger/i);

    const rollback = rollbackMemoryRelease(paths, {
      baseReleaseId: "rel_purged",
      targetReleaseId: "rel_safe",
      releaseId: "rel_safe_rollback",
    });
    expect(rollback.cards.map((card) => card.id)).toEqual([
      fixture.safeCard.id,
    ]);
  });

  it("fails CAS before writing a purge ledger record", () => {
    publishMemoryRelease(paths, {
      baseReleaseId: null,
      releaseId: "rel_current",
      changes: [{ type: "create", card: makeCard() }],
    });

    expect(() => hardPurgeMemories({
      memoryRoot: rootDir,
      workdir,
      scope: "project",
      baseReleaseId: "rel_stale",
      targets: { ids: ["pref_private"] },
    })).toThrow(/CURRENT changed/i);
    expect(readCurrentReleaseId(paths)).toBe("rel_current");
    expect(fs.existsSync(paths.purgeLedgerPath)).toBe(false);
  });

  it("cleans global memory from canonical projects without discovering flat sessions", () => {
    const globalPaths = resolveMemoryScopePaths({
      rootDir,
      scope: "global",
    });
    const secret = "GLOBAL_PRIVATE_MARKER_93ca";
    const globalCard = makeCard({
      id: "pref_global_private",
      logicalKey: "identity.global-private",
      scope: "global",
      title: "Global private detail",
      body: `Global detail ${secret}.`,
      evidence: [{
        sessionId: "evidence-session",
        eventSeq: 2,
        eventHash: "sha256:global-private",
        actor: "user",
        signal: "explicit_private_detail",
        excerpt: secret,
      }],
    });
    publishMemoryRelease(globalPaths, {
      baseReleaseId: null,
      releaseId: "rel_global_private",
      changes: [{ type: "create", card: globalCard }],
    });

    const projectA = path.join(rootDir, "projects", "a".repeat(64));
    const projectB = path.join(rootDir, "projects", "b".repeat(64));
    const evidenceSession = path.join(
      projectA,
      "sessions",
      "evidence-session.jsonl",
    );
    const textMatchSession = path.join(
      projectB,
      "sessions",
      "text-match-session.jsonl",
    );
    const safeSession = path.join(
      projectB,
      "sessions",
      "safe-session.jsonl",
    );
    const legacySession = path.join(
      rootDir,
      "sessions",
      "legacy-private.jsonl",
    );
    for (const [filePath, value] of [
      [evidenceSession, "source was paraphrased"],
      [textMatchSession, secret],
      [legacySession, secret],
    ] as const) {
      writeJsonLines(filePath, [
        { type: "message", data: value },
        { type: "session_closed", data: {} },
      ]);
    }
    writeJsonLines(safeSession, [
      { type: "message", data: "safe global session" },
      { type: "session_closed", data: {} },
    ]);
    for (const [base, records] of [
      [projectA, [
        { id: "evidence-session", summary: "source was paraphrased" },
      ]],
      [projectB, [
        { id: "text-match-session", summary: secret },
        { id: "safe-session", summary: "safe global session" },
      ]],
    ] as const) {
      writeFile(
        path.join(base, "sessions.json"),
        `${JSON.stringify(records, null, 2)}\n`,
      );
      writeFile(
        path.join(base, "session-catalog.tsv"),
        "session_id\tcreated_at\tlast_active_at\tstatus\tmodel\t" +
          "message_count\ttoken_count\tfirst_message\tsummary\ttranscript\n" +
          records.map((record) =>
            `${record.id}\t2026-07-31T00:00:00.000Z\t` +
            `2026-07-31T00:00:00.000Z\tended\tmodel\t1\t1\t` +
            `${record.summary}\t${record.summary}\t` +
            `sessions/${record.id}.jsonl`).join("\n") +
          "\n",
      );
    }

    const result = hardPurgeMemories({
      memoryRoot: rootDir,
      workdir,
      scope: "global",
      releaseId: "rel_global_purged",
      targets: {
        ids: [globalCard.id],
        logicalKeys: [globalCard.logicalKey],
        values: [secret],
      },
    });

    expect(result.complete).toBe(true);
    expect(fs.existsSync(evidenceSession)).toBe(false);
    expect(fs.existsSync(textMatchSession)).toBe(false);
    expect(fs.existsSync(legacySession)).toBe(true);
    expect(fs.existsSync(safeSession)).toBe(true);
    expect(fs.readFileSync(path.join(projectB, "sessions.json"), "utf8"))
      .toContain("safe-session");
    expect(fs.readFileSync(
      path.join(projectB, "session-catalog.tsv"),
      "utf8",
    )).toContain("safe-session");
    expect(fs.readFileSync(paths.purgeLedgerPath, "utf8"))
      .not.toContain("evidence-session");
  });

  it("keeps an ambiguous user skill, reports the residual, and enforces intent semantics", () => {
    const secret = "PRIVATE_MARKER_ambiguous_skill";
    const privateCard = makeCard({
      id: "pref_private",
      logicalKey: "identity.private",
      title: "Private preference",
      body: `Remember ${secret}.`,
    });
    publishMemoryRelease(paths, {
      baseReleaseId: null,
      releaseId: "rel_private",
      changes: [{ type: "create", card: privateCard }],
    });
    const userSkill = path.join(rootDir, "skills", "handwritten", "SKILL.md");
    writeFile(userSkill, `# My own skill\n\nKeep ${secret} here.\n`);

    expect(() => previewHardPurge({
      memoryRoot: rootDir,
      workdir,
      scope: "project",
      intent: "forget",
      targets: { values: [secret] },
    })).toThrow(/forget requires/i);
    expect(() => previewHardPurge({
      memoryRoot: rootDir,
      workdir,
      scope: "project",
      intent: "purge",
      targets: { values: ["abc"] },
    })).toThrow(/four characters/i);

    const result = hardPurgeMemories({
      memoryRoot: rootDir,
      workdir,
      scope: "project",
      intent: "purge",
      releaseId: "rel_value_purge",
      targets: { values: [secret] },
    });
    expect(fs.existsSync(userSkill)).toBe(true);
    expect(result.complete).toBe(false);
    expect(result.residuals).toEqual(expect.arrayContaining([
      { path: path.dirname(userSkill), reason: "unclassified_skill" },
      { path: userSkill, reason: "post_scan_match" },
    ]));
  });
});

interface CompleteFixture {
  secret: string;
  safeCard: MemoryCard;
  privateCard: MemoryCard;
  observationPath: string;
  privateCandidate: string;
  privateDream: string;
  privateSession: string;
  truncatedSession: string;
  slugSession: string;
  summaryPath: string;
  catalogPath: string;
  accessPath: string;
  outcomePath: string;
  globalDerivedSkill: string;
  projectDerivedSkill: string;
}

function buildCompleteFixture(
  rootDir: string,
  workdir: string,
  paths: MemoryScopePaths,
): CompleteFixture {
  const secret = "PRIVATE_MARKER_7398bde";
  const safeCard = makeCard();
  const privateCard = makeCard({
    id: "pref_private",
    logicalKey: "identity.private-detail",
    title: "Private detail",
    body: `The user's private marker is ${secret}.`,
    sensitivity: "sensitive",
    evidence: [{
      sessionId: "private-session",
      eventSeq: 1,
      eventHash: "sha256:private",
      actor: "user",
      signal: "explicit_private_detail",
      excerpt: `Please remember ${secret}.`,
    }],
  });
  publishMemoryRelease(paths, {
    baseReleaseId: null,
    releaseId: "rel_safe",
    createdAt: "2026-07-31T00:00:00.000Z",
    changes: [{ type: "create", card: safeCard }],
  });
  publishMemoryRelease(paths, {
    baseReleaseId: "rel_safe",
    releaseId: "rel_private",
    createdAt: "2026-07-31T01:00:00.000Z",
    changes: [{ type: "create", card: privateCard }],
  });

  const observationPath = path.join(
    paths.scopeDir,
    "observations",
    "2026",
    "07",
    "2026-07-31.jsonl",
  );
  writeJsonLines(observationPath, [
    { id: "obs-private", value: secret, memory_id: privateCard.id },
    { id: "obs-safe", value: "safe observation", memory_id: safeCard.id },
  ]);

  const privateCandidate = path.join(
    paths.scopeDir,
    "candidates",
    "pending",
    "candidate-private.json",
  );
  writeFile(privateCandidate, JSON.stringify({
    id: "candidate-private",
    logical_key: privateCard.logicalKey,
    value: secret,
  }));
  writeFile(
    path.join(paths.scopeDir, "candidates", "pending", "candidate-safe.json"),
    JSON.stringify({ id: "candidate-safe", value: "safe candidate" }),
  );

  const privateDream = path.join(paths.scopeDir, "dreams", "dream-private");
  writeFile(path.join(privateDream, "run.json"), JSON.stringify({
    run_id: "dream-private",
    observation_ids: ["obs-private"],
    result: secret,
  }));
  writeFile(
    path.join(paths.scopeDir, "dreams", "dream-safe", "run.json"),
    JSON.stringify({ run_id: "dream-safe", result: "safe dream" }),
  );

  const projectId = projectMemoryId(workdir);
  const sessionsDir = path.join(rootDir, "projects", projectId, "sessions");
  const privateSession = path.join(sessionsDir, "private-session.jsonl");
  writeJsonLines(privateSession, [
    { type: "message", data: { text: secret } },
    { type: "session_closed", data: {} },
  ]);
  writeJsonLines(path.join(sessionsDir, "safe-session.jsonl"), [
    { type: "message", data: { text: "safe session" } },
    { type: "session_closed", data: {} },
  ]);
  const truncatedSession = path.join(
    rootDir,
    "projects",
    createHash("sha256").update(path.resolve(workdir)).digest("hex").slice(0, 16),
    "sessions",
    "truncated-private.jsonl",
  );
  const slugSession = path.join(
    rootDir,
    "projects",
    legacyProjectId(workdir),
    "sessions",
    "slug-private.jsonl",
  );
  for (const legacySession of [truncatedSession, slugSession]) {
    writeJsonLines(legacySession, [
      { type: "message", data: { text: secret } },
      { type: "session_closed", data: {} },
    ]);
  }
  const summaryPath = path.join(rootDir, "projects", projectId, "sessions.json");
  writeFile(summaryPath, `${JSON.stringify([
    { id: "private-session", summary: secret },
    { id: "safe-session", summary: "safe summary" },
  ], null, 2)}\n`);
  const catalogPath = path.join(
    rootDir,
    "projects",
    projectId,
    "session-catalog.tsv",
  );
  writeFile(
    catalogPath,
    "session_id\tcreated_at\tlast_active_at\tstatus\tmodel\t" +
      "message_count\ttoken_count\tfirst_message\tsummary\ttranscript\n" +
      `private-session\t2026-07-31T00:00:00.000Z\t` +
      `2026-07-31T00:00:00.000Z\tended\tmodel\t1\t1\t${secret}\t` +
      `${secret}\tsessions/private-session.jsonl\n` +
      "safe-session\t2026-07-31T00:00:00.000Z\t" +
      "2026-07-31T00:00:00.000Z\tended\tmodel\t1\t1\tsafe\t" +
      "safe summary\tsessions/safe-session.jsonl\n",
  );

  const accessPath = path.join(rootDir, "memory", "access.jsonl");
  writeJsonLines(accessPath, [
    { event_id: "access-private", memory_ids: [privateCard.id] },
    { event_id: "access-safe", memory_ids: [safeCard.id] },
  ]);

  const outcomePath = path.join(rootDir, "memory", "outcomes.jsonl");
  writeOutcomeChain(outcomePath, [
    { event_id: "out-private", memory_applied: [privateCard.id] },
    { event_id: "out-safe", memory_applied: [safeCard.id] },
  ]);

  const globalDerivedSkill = path.join(
    rootDir,
    "skills",
    "derived-private",
  );
  writeFile(
    path.join(globalDerivedSkill, "SKILL.md"),
    `---\ngenerated_by: rubato-memory\nsource_memory_ids:\n` +
      `  - ${privateCard.id}\n---\n\n${secret}\n`,
  );
  const projectDerivedSkill = path.join(
    workdir,
    ".rubato",
    "skills",
    "derived-private",
  );
  writeFile(
    path.join(projectDerivedSkill, "SKILL.md"),
    `---\nx-rubato-generated-by: memory-dream\n---\n\n${secret}\n`,
  );

  return {
    secret,
    safeCard,
    privateCard,
    observationPath,
    privateCandidate,
    privateDream,
    privateSession,
    truncatedSession,
    slugSession,
    summaryPath,
    catalogPath,
    accessPath,
    outcomePath,
    globalDerivedSkill,
    projectDerivedSkill,
  };
}

function makeCard(overrides: Partial<MemoryCard> = {}): MemoryCard {
  return {
    schemaVersion: 1,
    id: "pref_safe",
    revision: 1,
    logicalKey: "communication.language",
    kind: "preference",
    scope: "project",
    status: "confirmed",
    origin: "explicit",
    application: "automatic",
    authority: "user_explicit",
    sensitivity: "normal",
    confidence: 0.98,
    supportScore: 3,
    oppositionScore: 0,
    halfLifeDays: null,
    title: "Preferred language",
    body: "Use Chinese by default.",
    conditions: [],
    exceptions: [],
    aliases: [],
    tags: ["communication"],
    contexts: {
      domains: [],
      projects: [],
      surfaces: [],
      languages: ["zh-CN"],
    },
    createdAt: "2026-07-31T00:00:00.000Z",
    updatedAt: "2026-07-31T00:00:00.000Z",
    firstSeenAt: "2026-07-30T00:00:00.000Z",
    lastSeenAt: "2026-07-31T00:00:00.000Z",
    lastConfirmedAt: "2026-07-31T00:00:00.000Z",
    evidence: [{
      sessionId: "session-safe",
      eventSeq: 1,
      eventHash: "sha256:safe",
      actor: "user",
      signal: "explicit_preference",
      excerpt: "Use Chinese by default.",
    }],
    supersedes: [],
    conflicts: [],
    ...overrides,
  };
}

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function writeJsonLines(filePath: string, values: unknown[]): void {
  writeFile(filePath, `${values.map((item) => JSON.stringify(item)).join("\n")}\n`);
}

function writeOutcomeChain(
  filePath: string,
  records: Array<Record<string, unknown>>,
): void {
  let previousHash = "0".repeat(64);
  const chained = records.map((record) => {
    const unsigned = { ...record, prev_hash: previousHash };
    const event = {
      ...unsigned,
      hash: createHash("sha256").update(stableJson(unsigned)).digest("hex"),
    };
    previousHash = event.hash;
    return event;
  });
  writeJsonLines(filePath, chained);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) =>
      `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function findLiteralMatches(
  roots: string[],
  target: string,
  excluded: Set<string>,
): string[] {
  const matches: string[] = [];
  const visit = (candidate: string): void => {
    if (!fs.existsSync(candidate)) return;
    if ([...excluded].some((item) => path.resolve(item) === path.resolve(candidate))) {
      return;
    }
    const stat = fs.lstatSync(candidate);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      fs.readdirSync(candidate).forEach((entry) =>
        visit(path.join(candidate, entry)));
      return;
    }
    if (stat.isFile() && fs.readFileSync(candidate).includes(target)) {
      matches.push(candidate);
    }
  };
  roots.forEach(visit);
  return [...new Set(matches)].sort();
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
  fs.readdirSync(target).forEach((entry) =>
    makeTreeWritable(path.join(target, entry)));
}

function legacyProjectId(projectDir: string): string {
  return path.resolve(projectDir)
    .replace(/[^a-zA-Z0-9]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64) || "root";
}
