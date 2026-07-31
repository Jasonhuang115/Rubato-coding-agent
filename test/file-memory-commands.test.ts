import fs from "fs";
import os from "os";
import path from "path";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import { handleJournalCommand } from "../src/cli/command-handlers.js";
import {
  handleFileMemoryCommand,
  handleProfileCommand,
} from "../src/cli/file-memory-commands.js";
import {
  controlEventPath,
  listMemoryControlEvents,
} from "../src/memory-files/control-events.js";
import { listDreamRuns } from "../src/memory-files/dream.js";
import type { UserObservation } from "../src/memory-files/observation.js";
import { loadMemoryPolicy } from "../src/memory-files/policy.js";
import {
  publishMemoryRelease,
  readCurrentRelease,
  readCurrentReleaseId,
  readMemoryRelease,
} from "../src/memory-files/release.js";
import { FileMemoryRepository } from "../src/memory-files/repository.js";
import type { MemoryCard } from "../src/memory-files/types.js";

const NOW = "2026-07-31T00:00:00.000Z";

describe("file-memory CLI commands", () => {
  let root = "";
  let project = "";
  let repository: FileMemoryRepository;
  let previousRubatoHome: string | undefined;
  let output: string[];
  let logSpy: MockInstance;

  beforeEach(() => {
    previousRubatoHome = process.env.RUBATO_HOME;
    root = fs.mkdtempSync(path.join(os.tmpdir(), "rubato-memory-cli-"));
    project = path.join(root, "project");
    fs.mkdirSync(project);
    process.env.RUBATO_HOME = root;
    repository = new FileMemoryRepository({ projectDir: project });
    output = [];
    logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      output.push(args.map(String).join(" "));
    });

    publishMemoryRelease(repository.globalPaths, {
      baseReleaseId: null,
      releaseId: "global-v1",
      createdAt: NOW,
      changes: [
        {
          type: "create",
          card: makeCard({
          id: "language-pref",
          logicalKey: "communication.language",
          title: "Answer language",
          body: "Prefer Chinese answers.",
          scope: "global",
          confidence: 0.97,
          evidence: [{
            sessionId: "session-global",
            eventSeq: 7,
            eventHash: "a".repeat(64),
            actor: "user",
            signal: "explicit_preference",
            excerpt: "请默认用中文回答",
          }],
          contexts: {
            domains: [],
            projects: [],
            surfaces: ["cli"],
            languages: ["zh-CN"],
          },
        }),
        },
      ],
    });
    publishMemoryRelease(repository.projectPaths, {
      baseReleaseId: null,
      releaseId: "project-v1",
      createdAt: NOW,
      changes: [{
        type: "create",
        card: makeCard({
          id: "testing-pref",
          logicalKey: "workflow.testing",
          title: "Test workflow",
          body: "Run focused tests before the full suite.",
          kind: "workflow",
          scope: "project",
          application: "advisory",
          authority: "user_inferred",
          confidence: 0.74,
          evidence: [{
            sessionId: "session-project",
            eventSeq: 9,
            eventHash: "b".repeat(64),
            actor: "user",
            signal: "habit",
          }],
        }),
      }],
    });
    repository.appendObservation(makeObservation(repository));
  });

  afterEach(() => {
    logSpy.mockRestore();
    if (previousRubatoHome === undefined) delete process.env.RUBATO_HOME;
    else process.env.RUBATO_HOME = previousRubatoHome;
    makeTreeWritable(root);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("shows only current verified profiles and exposes learning state", async () => {
    await handleProfileCommand("/profile show", project);
    const text = joinedOutput();

    expect(text).toContain("仅来自通过哈希验证的 CURRENT release");
    expect(text).toContain("global-v1");
    expect(text).toContain("project-v1");
    expect(text).toContain("Answer language");
    expect(text).not.toContain("raw observation");
  });

  it("explains a memory with release authority, confidence, scope, and event provenance", async () => {
    await handleProfileCommand(
      "/profile why communication.language",
      project,
    );
    const text = joinedOutput();

    expect(text).toContain("[verified card] communication.language");
    expect(text).toContain("release=global-v1");
    expect(text).toContain("scope=global");
    expect(text).toContain("application=automatic");
    expect(text).toContain("authority=user_explicit");
    expect(text).toContain("confidence=0.970");
    expect(text).toContain("contexts=surfaces=cli; languages=zh-CN");
    expect(text).toContain("session=session-global");
    expect(text).toContain("event_seq=7");
    expect(text).toContain("event_hash=aaaaaaaaaaaaaaaa…");
    expect(text).toContain("user_evidence:");
    expect(text).toContain("[raw observation] communication.language");
    expect(text).toContain("event_id=event-project");
  });

  it("exports inspectable JSON while excluding secret cards by default", async () => {
    await handleProfileCommand("/profile export", project);
    const exported = JSON.parse(output.at(-1)!) as {
      schema: string;
      includes_secret: boolean;
      omitted_secret_cards: number;
      scopes: Array<{ release_id: string | null; cards: MemoryCard[] }>;
      observations: UserObservation[];
    };

    expect(exported.schema).toBe("rubato.memory.profile-export/v1");
    expect(exported.scopes.map((scope) => scope.release_id)).toEqual([
      "global-v1",
      "project-v1",
    ]);
    expect(exported.scopes.flatMap((scope) => scope.cards)).toHaveLength(2);
    expect(exported.includes_secret).toBe(false);
    expect(exported.omitted_secret_cards).toBe(0);
    expect(exported.scopes.flatMap((scope) => scope.cards)
      .some((card) => card.sensitivity === "secret")).toBe(false);
    expect(exported.observations).toEqual([
      expect.objectContaining({
        logicalKey: "communication.language",
        sessionId: "session-observation",
      }),
    ]);

    output.length = 0;
    await handleProfileCommand("/profile export --include-secret", project);
    const explicit = JSON.parse(output.at(-1)!) as {
      includes_secret: boolean;
      scopes: Array<{ cards: MemoryCard[] }>;
    };
    expect(explicit.includes_secret).toBe(true);
    expect(explicit.scopes.flatMap((scope) => scope.cards)).toHaveLength(2);
  });

  it("pauses and resumes learning without rewriting releases", async () => {
    const globalBefore = readCurrentReleaseId(repository.globalPaths);
    const projectBefore = readCurrentReleaseId(repository.projectPaths);

    await handleProfileCommand("/profile pause-learning", project);
    expect(loadMemoryPolicy().learning_enabled).toBe(false);
    expect(readCurrentReleaseId(repository.globalPaths)).toBe(globalBefore);
    expect(readCurrentReleaseId(repository.projectPaths)).toBe(projectBefore);

    await handleProfileCommand("/profile resume-learning", project);
    expect(loadMemoryPolicy().learning_enabled).toBe(true);
    expect(readCurrentReleaseId(repository.globalPaths)).toBe(globalBefore);
    expect(readCurrentReleaseId(repository.projectPaths)).toBe(projectBefore);
    expect(listMemoryControlEvents(root).map((event) => event.action)).toEqual([
      "pause_learning",
      "resume_learning",
    ]);
  });

  it("reports stats and uses verified catalog files for list/search", async () => {
    await handleFileMemoryCommand("/memory stats", project);
    await handleFileMemoryCommand("/memory search focused tests", project);
    await handleFileMemoryCommand("/memory list", project);
    const text = joinedOutput();

    expect(text).toContain("文件记忆统计（无向量库 / 无 RAG）");
    expect(text).toContain("verified cards：2");
    expect(text).toContain("npm run migrate:legacy");
    expect(text).toContain("workflow.testing");
    expect(text).toContain("Test workflow");
    expect(text).toContain("project-v1");
  });

  it("persists Dream queue records but neither executes nor publishes them", async () => {
    const globalBefore = readCurrentReleaseId(repository.globalPaths);
    const projectBefore = readCurrentReleaseId(repository.projectPaths);

    await handleFileMemoryCommand("/memory dream", project);

    const runs = [
      ...listDreamRuns(repository.dreamsDir("global")),
      ...listDreamRuns(repository.dreamsDir("project")),
    ];
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      scope: "project",
      status: "queued",
      observation_ids: ["observation-1"],
    });
    expect(runs[0].operation_count).toBeUndefined();
    expect(runs[0].release_id).toBeUndefined();
    expect(
      fs.existsSync(path.join(
        repository.dreamsDir("project"),
        runs[0].run_id,
        "operations.json",
      )),
    ).toBe(false);
    expect(readCurrentReleaseId(repository.globalPaths)).toBe(globalBefore);
    expect(readCurrentReleaseId(repository.projectPaths)).toBe(projectBefore);
    expect(joinedOutput()).toContain("仅 queued；本命令不会执行、验证或发布");
  });

  it("requires an explicit --run before a Dream may spend a model call", async () => {
    await handleFileMemoryCommand("/memory dream --run", project);
    const text = joinedOutput();

    expect(text).toContain("仅 queued");
    expect(text).toContain("没有模型配置");
    expect(listDreamRuns(repository.dreamsDir("project"))
      .every((run) => run.status === "queued")).toBe(true);
  });

  it("scans project facts on demand and can audit them read-only", async () => {
    await handleFileMemoryCommand("/memory bootstrap", project);
    expect(joinedOutput()).toContain("不是一个项目");

    output.length = 0;
    fs.writeFileSync(
      path.join(project, "package.json"),
      JSON.stringify({ name: "cli-fixture", version: "1.0.0" }, null, 2),
    );
    await handleFileMemoryCommand("/memory bootstrap", project);
    expect(joinedOutput()).toContain("已扫描");
    const cards = readCurrentRelease(repository.projectPaths)!.cards;
    expect(cards.some((card) => card.authority === "repository")).toBe(true);
    // The user's own card survives a repository scan in the same scope.
    expect(cards.some((card) => card.id === "testing-pref")).toBe(true);

    output.length = 0;
    const releaseBefore = readCurrentReleaseId(repository.projectPaths);
    await handleFileMemoryCommand("/memory bootstrap --check", project);
    expect(joinedOutput()).toContain("只读，未写入任何 release");
    expect(readCurrentReleaseId(repository.projectPaths)).toBe(releaseBefore);
  });

  it("answers the legacy /journal recent alias with the file-memory list", async () => {
    await handleJournalCommand("/journal recent", project);
    const text = joinedOutput();

    expect(text).toContain("workflow.testing");
    expect(text).toContain("project-v1");
  });

  it("corrects a profile value through a CAS-protected immutable release", async () => {
    await handleProfileCommand(
      "/profile correct communication.language Prefer Japanese answers.",
      project,
    );
    const current = readCurrentRelease(repository.globalPaths)!;

    expect(current.id).not.toBe("global-v1");
    expect(current.manifest.parentReleaseId).toBe("global-v1");
    expect(current.cards.find((card) =>
      card.logicalKey === "communication.language")).toMatchObject({
        body: "Prefer Japanese answers.",
        status: "confirmed",
        authority: "user_explicit",
        application: "automatic",
        revision: 1,
        evidence: [expect.objectContaining({
          actor: "user",
          signal: "correction",
          sessionId: `control:${repository.projectId}`,
        })],
      });
    expect(readMemoryRelease(repository.globalPaths, "global-v1").cards
      .find((card) => card.logicalKey === "communication.language")?.body)
      .toBe("Prefer Chinese answers.");
    const controls = listMemoryControlEvents(root);
    expect(controls).toHaveLength(1);
    expect(controls[0]).toMatchObject({
      action: "correct",
      seq: 0,
      prev_hash: null,
    });
    expect(current.cards.find((card) =>
      card.logicalKey === "communication.language")?.evidence[0]).toMatchObject({
        eventSeq: controls[0].seq,
        eventHash: controls[0].hash,
      });
    expect(fs.readFileSync(controlEventPath(root), "utf8"))
      .not.toContain("Prefer Japanese answers.");
    await handleProfileCommand(
      "/profile why communication.language",
      project,
    );
    expect(joinedOutput()).toContain("control_chain=verified");
    expect(joinedOutput()).toContain("发布 verified release");
  });

  it("retires a memory through the release reducer and can undo it", async () => {
    await handleFileMemoryCommand("/memory retire testing-pref", project);
    const retiredRelease = readCurrentRelease(repository.projectPaths)!;
    expect(retiredRelease.cards).toEqual([]);
    expect(retiredRelease.manifest.changes).toEqual([
      expect.objectContaining({
        type: "retire",
        logicalKey: "workflow.testing",
      }),
    ]);

    await handleFileMemoryCommand("/memory undo", project);
    const undone = readCurrentRelease(repository.projectPaths)!;
    expect(undone.id).not.toBe(retiredRelease.id);
    expect(undone.manifest).toMatchObject({
      parentReleaseId: retiredRelease.id,
      rollbackOf: "project-v1",
    });
    expect(undone.cards.map((card) => card.id)).toEqual(["testing-pref"]);
    expect(listMemoryControlEvents(root).map((event) => event.action)).toEqual([
      "retire",
      "undo",
    ]);
    expect(joinedOutput()).toContain("隐私 purge ledger 不会被回滚");
  });

  it("previews forget without writes, then hard-purges all matching scopes", async () => {
    const globalBefore = readCurrentReleaseId(repository.globalPaths);
    const projectBefore = readCurrentReleaseId(repository.projectPaths);

    await handleProfileCommand(
      "/profile forget communication.language --dry-run",
      project,
    );
    expect(joinedOutput()).toContain("Hard-purge dry run");
    expect(joinedOutput()).toContain("仅预览");
    expect(readCurrentReleaseId(repository.globalPaths)).toBe(globalBefore);
    expect(readCurrentReleaseId(repository.projectPaths)).toBe(projectBefore);
    expect(repository.listObservations("project")).toHaveLength(1);
    expect(listMemoryControlEvents(root)).toEqual([]);

    output.length = 0;
    await handleProfileCommand(
      "/profile forget communication.language",
      project,
    );

    expect(readCurrentRelease(repository.globalPaths)?.cards
      .some((card) => card.logicalKey === "communication.language")).toBe(false);
    expect(repository.listObservations("project")).toEqual([]);
    expect(fs.existsSync(path.join(
      repository.globalPaths.releasesDir,
      "global-v1",
    ))).toBe(false);
    expect(listMemoryControlEvents(root).map((event) => event.action))
      .toEqual(["forget"]);
    const controlText = fs.readFileSync(controlEventPath(root), "utf8");
    expect(controlText).not.toContain("communication.language");
    expect(controlText).not.toContain("zh-CN");
    expect(joinedOutput()).toContain("不可回滚 purge ledger");
  });

  it("routes legacy migration to the offline script and reports mutation usage errors", async () => {
    await handleFileMemoryCommand("/memory legacy migrate", project);
    await handleFileMemoryCommand("/memory correct", project);
    await handleProfileCommand("/profile retire", project);
    const text = joinedOutput();

    expect(text).toContain("npm run migrate:legacy");
    expect(text).toContain("只产出待复核 candidate");
    expect(text).toContain("请使用 /profile correct");
    expect(text).toContain("请使用 /memory retire");
  });

  it("fails closed instead of reading a tampered current release", async () => {
    const profilePath = path.join(
      repository.globalPaths.releasesDir,
      "global-v1",
      "PROFILE.md",
    );
    fs.chmodSync(profilePath, 0o600);
    fs.appendFileSync(profilePath, "\nTAMPERED PROFILE\n", "utf8");

    await handleProfileCommand("/profile show", project);
    const text = joinedOutput();

    expect(text).toContain("release 无法验证，因此未读取");
    expect(text).not.toContain("TAMPERED PROFILE");
    expect(text).toContain("project-v1");
  });

  function joinedOutput(): string {
    return output.join("\n");
  }
});

function makeObservation(repository: FileMemoryRepository): UserObservation {
  return {
    id: "observation-1",
    actor: "user",
    signal: "explicit_preference",
    logicalKey: "communication.language",
    value: "zh-CN",
    scope: { kind: "project", value: repository.projectId },
    polarity: "support",
    sessionId: "session-observation",
    eventId: "event-project",
    eventSeq: 11,
    eventHash: "c".repeat(64),
    observedAt: NOW,
  };
}

function makeCard(overrides: Partial<MemoryCard> = {}): MemoryCard {
  return {
    schemaVersion: 1,
    id: "default-pref",
    revision: 1,
    logicalKey: "communication.detail",
    kind: "preference",
    scope: "global",
    status: "confirmed",
    origin: "explicit",
    application: "automatic",
    authority: "user_explicit",
    sensitivity: "normal",
    confidence: 0.95,
    supportScore: 8,
    oppositionScore: 0,
    halfLifeDays: null,
    title: "Detailed answers",
    body: "Explain important trade-offs.",
    conditions: [],
    exceptions: [],
    aliases: ["detail"],
    tags: ["communication"],
    contexts: {
      domains: [],
      projects: [],
      surfaces: ["cli"],
      languages: [],
    },
    createdAt: NOW,
    updatedAt: NOW,
    firstSeenAt: NOW,
    lastSeenAt: NOW,
    lastConfirmedAt: NOW,
    evidence: [{
      sessionId: "session-default",
      eventSeq: 1,
      eventHash: "d".repeat(64),
      actor: "user",
      signal: "explicit_preference",
    }],
    supersedes: [],
    conflicts: [],
    ...overrides,
  };
}

function makeTreeWritable(root: string): void {
  if (!fs.existsSync(root)) return;
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory()) {
    fs.chmodSync(root, 0o644);
    return;
  }
  fs.chmodSync(root, 0o755);
  for (const entry of fs.readdirSync(root)) {
    makeTreeWritable(path.join(root, entry));
  }
}
