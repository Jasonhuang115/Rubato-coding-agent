import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  leaseNextDream,
  listDreamRuns,
  queueDream,
} from "../src/memory-files/dream.js";
import {
  pendingDreamSummary,
  runQueuedDreams,
} from "../src/memory-files/dream-runner.js";
import type { DreamProposal } from "../src/memory-files/dream-worker.js";
import { projectMemoryId } from "../src/memory-files/paths.js";
import { setMemoryLearningEnabled } from "../src/memory-files/policy.js";
import { FileMemoryRepository } from "../src/memory-files/repository.js";
import { readCurrentRelease } from "../src/memory-files/release.js";
import {
  runMemoryMaintenance,
  startMemoryMaintenance,
} from "../src/cli/memory-maintenance.js";
import { SessionStore } from "../src/runtime/session/storage.js";
import type {
  AgentConfig,
  ChatParams,
  ModelProvider,
  StreamEvent,
} from "../src/shared/core-types.js";

describe("dream runner", () => {
  const fixture = useTempRoot();

  it("drains the queue scope by scope under an explicit run cap", async () => {
    const repository = fixture.repository();
    const project = queueNoopDream(fixture, "project");
    const global = queueNoopDream(fixture, "global");
    const model = new FakeModelProvider(noopPipeline(project, global));

    const first = await runQueuedDreams({
      workingDir: fixture.project,
      rootDir: fixture.rootDir,
      model,
      modelName: "fake",
      maxRuns: 1,
    });

    expect(first.attempted).toBe(1);
    expect(first.errors).toEqual([]);
    expect(first.publishedReleaseIds).toEqual([]);
    // Project scope is drained before global, so only the global run is left.
    expect(pendingDreamSummary(fixture.project, fixture.rootDir)).toEqual({
      queued: 1,
      byScope: { global: 1, project: 0 },
    });
    expect(statusOf(repository, "project", project.runId)).toBe("rejected");

    const second = await runQueuedDreams({
      workingDir: fixture.project,
      rootDir: fixture.rootDir,
      model,
      modelName: "fake",
      maxRuns: 1,
    });

    expect(second.attempted).toBe(1);
    expect(statusOf(repository, "global", global.runId)).toBe("rejected");
    expect(pendingDreamSummary(fixture.project, fixture.rootDir).queued).toBe(0);
    // Six model calls total: three pipeline stages per Dream, no extra retries.
    expect(model.calls).toHaveLength(6);
    expect(readCurrentRelease(repository.projectPaths)).toBeNull();
  });

  it("returns an empty queue rather than starting a Dream when nothing is pending", async () => {
    const model = new FakeModelProvider([]);
    const result = await runQueuedDreams({
      workingDir: fixture.project,
      rootDir: fixture.rootDir,
      model,
      modelName: "fake",
    });

    expect(result.attempted).toBe(0);
    expect(model.calls).toEqual([]);
  });

  it("reclaims a lease that expired without a worker finishing it", () => {
    const repository = fixture.repository();
    const dream = queueNoopDream(fixture, "project", "expired-lease", 1);
    leaseNextDream(
      repository.dreamsDir("project"),
      "dead-worker",
      1,
      new Date(0),
    );
    expect(statusOf(repository, "project", dream.runId)).toBe("leased");

    expect(pendingDreamSummary(fixture.project, fixture.rootDir)).toEqual({
      queued: 1,
      byScope: { global: 0, project: 1 },
    });
    expect(statusOf(repository, "project", dream.runId)).toBe("queued");
  });

  it("spends no model call when memory is off or learning is paused", async () => {
    const dream = queueNoopDream(fixture, "project");
    const model = new FakeModelProvider(noopPipeline(dream));

    const disabled = await runQueuedDreams({
      workingDir: fixture.project,
      rootDir: fixture.rootDir,
      model,
      modelName: "fake",
      enabled: false,
    });
    expect(disabled).toMatchObject({ attempted: 0, skipped: ["memory_disabled"] });

    setMemoryLearningEnabled(false, fixture.rootDir);
    const paused = await runQueuedDreams({
      workingDir: fixture.project,
      rootDir: fixture.rootDir,
      model,
      modelName: "fake",
    });
    expect(paused).toMatchObject({
      attempted: 0,
      skipped: ["memory_learning_paused"],
    });
    expect(model.calls).toEqual([]);
    expect(pendingDreamSummary(fixture.project, fixture.rootDir).queued).toBe(1);
  });

  it("stops on an aborted signal before touching the queue", async () => {
    const dream = queueNoopDream(fixture, "project");
    const controller = new AbortController();
    controller.abort();
    const model = new FakeModelProvider(noopPipeline(dream));

    const result = await runQueuedDreams({
      workingDir: fixture.project,
      rootDir: fixture.rootDir,
      model,
      modelName: "fake",
      signal: controller.signal,
    });

    expect(result).toMatchObject({ attempted: 0, skipped: ["cancelled"] });
    expect(model.calls).toEqual([]);
    expect(pendingDreamSummary(fixture.project, fixture.rootDir).queued).toBe(1);
  });

  it("does not start another Dream once the wall-clock budget is gone", async () => {
    const first = queueNoopDream(fixture, "project", "budget-a");
    const second = queueNoopDream(fixture, "project", "budget-b");
    const model = new FakeModelProvider(noopPipeline(first, second), 1_200);

    const result = await runQueuedDreams({
      workingDir: fixture.project,
      rootDir: fixture.rootDir,
      model,
      modelName: "fake",
      maxRuns: 5,
      budgetMs: 1_000,
    });

    expect(result.attempted).toBe(1);
    expect(result.skipped).toEqual(["budget_exhausted"]);
    expect(pendingDreamSummary(fixture.project, fixture.rootDir).queued).toBe(1);
  });

  it("surfaces a failed Dream as review work instead of a thrown error", async () => {
    const repository = fixture.repository();
    queueNoopDream(fixture, "project");
    const model = new FakeModelProvider(["not-json"]);

    const result = await runQueuedDreams({
      workingDir: fixture.project,
      rootDir: fixture.rootDir,
      model,
      modelName: "fake",
    });

    expect(result.attempted).toBe(1);
    expect(result.errors).not.toEqual([]);
    expect(result.publishedReleaseIds).toEqual([]);
    expect(result.needsReview).toBeGreaterThan(0);
    expect(readCurrentRelease(repository.projectPaths)).toBeNull();
  });
});

describe("CLI memory maintenance", () => {
  const fixture = useTempRoot();

  it("bootstraps repository facts and reports the change once", async () => {
    const reports: string[] = [];
    const first = await runMemoryMaintenance({
      workingDir: fixture.project,
      rootDir: fixture.rootDir,
      config: agentConfig(),
      report: (message) => reports.push(message),
    });

    expect(first.bootstrap?.created.length).toBeGreaterThan(0);
    expect(first.skipped).toEqual(["dream_queue_empty"]);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain("/memory list");

    const second = await runMemoryMaintenance({
      workingDir: fixture.project,
      rootDir: fixture.rootDir,
      config: agentConfig(),
      report: (message) => reports.push(message),
    });

    // A warm start scans, finds nothing new, and stays quiet.
    expect(second.bootstrap?.created).toEqual([]);
    expect(second.bootstrap?.unchanged).toBeGreaterThan(0);
    expect(reports).toHaveLength(1);
  });

  it.each([
    ["memory_disabled", { enabled: false }],
    ["memory_learning_paused", { learningEnabled: false }],
    ["bootstrap_disabled", { bootstrapEnabled: false }],
  ] as const)("skips with %s when configured off", async (reason, overrides) => {
    const result = await runMemoryMaintenance({
      workingDir: fixture.project,
      rootDir: fixture.rootDir,
      config: agentConfig(overrides),
      report: () => {},
    });

    expect(result.skipped).toContain(reason);
    expect(result.bootstrap).toBeUndefined();
    expect(result.dreams).toBeUndefined();
  });

  it("leaves a directory that is not a project alone", async () => {
    const bare = path.join(fixture.rootDir, "bare");
    fs.mkdirSync(bare);
    const result = await runMemoryMaintenance({
      workingDir: bare,
      rootDir: fixture.rootDir,
      config: agentConfig(),
      report: () => {},
    });

    expect(result.skipped).toEqual(["not_a_project", "dream_queue_empty"]);
    expect(result.bootstrap).toBeUndefined();
  });

  it("honors an opt-out of automatic Dreaming even with work queued", async () => {
    queueNoopDream(fixture, "project");
    const result = await runMemoryMaintenance({
      workingDir: fixture.project,
      rootDir: fixture.rootDir,
      config: agentConfig({ dreamAutoRun: false }),
      report: () => {},
    });

    expect(result.skipped).toContain("dream_auto_run_disabled");
    expect(result.dreams).toBeUndefined();
    expect(pendingDreamSummary(fixture.project, fixture.rootDir).queued).toBe(1);
  });

  it("records a provider failure instead of taking the session down", async () => {
    queueNoopDream(fixture, "project");
    const result = await runMemoryMaintenance({
      workingDir: fixture.project,
      rootDir: fixture.rootDir,
      config: agentConfig(),
      report: () => {},
    });

    expect(result.skipped.some((entry) => entry.startsWith("dream_failed:")))
      .toBe(true);
    expect(result.dreams).toBeUndefined();
    // The run stays queued, so a start with a working provider can retry it.
    expect(pendingDreamSummary(fixture.project, fixture.rootDir).queued).toBe(1);
  });

  it("stops after bootstrap when the caller cancels the pass", async () => {
    queueNoopDream(fixture, "project");
    const handle = startMemoryMaintenance({
      workingDir: fixture.project,
      rootDir: fixture.rootDir,
      config: agentConfig(),
      report: () => {},
    });
    handle.cancel();
    const result = await handle.done;

    expect(result.skipped).toContain("cancelled");
    expect(result.dreams).toBeUndefined();
    expect(pendingDreamSummary(fixture.project, fixture.rootDir).queued).toBe(1);
  });
});

interface TempRootFixture {
  readonly rootDir: string;
  readonly project: string;
  repository(): FileMemoryRepository;
}

function useTempRoot(): TempRootFixture {
  const fixture = {
    rootDir: "",
    project: "",
    repository(): FileMemoryRepository {
      return new FileMemoryRepository({
        rootDir: fixture.rootDir,
        projectDir: fixture.project,
      });
    },
  };
  let previousRubatoHome: string | undefined;

  beforeEach(() => {
    sessionCounter = 0;
    previousRubatoHome = process.env.RUBATO_HOME;
    fixture.rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rubato-dream-runner-"));
    fixture.project = path.join(fixture.rootDir, "project");
    fs.mkdirSync(fixture.project);
    process.env.RUBATO_HOME = fixture.rootDir;
    fs.writeFileSync(
      path.join(fixture.project, "package.json"),
      JSON.stringify({ name: "runner-fixture", version: "1.0.0" }, null, 2),
    );
  });

  afterEach(() => {
    if (previousRubatoHome === undefined) delete process.env.RUBATO_HOME;
    else process.env.RUBATO_HOME = previousRubatoHome;
    makeTreeWritable(fixture.rootDir);
    fs.rmSync(fixture.rootDir, { recursive: true, force: true });
  });

  return fixture;
}

function agentConfig(
  memoryOverrides: Partial<NonNullable<AgentConfig["memory"]>> = {},
): AgentConfig {
  return {
    model: { provider: "unconfigured-test-provider", model: "test" },
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
      ...memoryOverrides,
    },
    session: { cleanupPeriodDays: 30 },
  };
}

let sessionCounter = 0;

interface QueuedDream {
  runId: string;
  eventId: string;
}

/**
 * Queues a Dream over one closed session. Tests pair it with a NOOP proposal so
 * the whole pipeline and every queue transition run without ever producing a
 * publishable claim, which keeps runner tests from writing memory by accident.
 */
function queueNoopDream(
  fixture: TempRootFixture,
  scope: "project" | "global",
  reason = `runner-${scope}`,
  maxRetries = 0,
): QueuedDream {
  const repository = fixture.repository();
  const sessionId = `runner-session-${++sessionCounter}`;
  const store = new SessionStore(sessionId, projectMemoryId(fixture.project));
  store.init();
  store.writeMessage({ role: "user", content: "Nothing durable here." });
  const eventId = store.getRecords()[0].event_id;
  store.close();

  const run = queueDream(repository.dreamsDir(scope), {
    scope,
    ...(scope === "project" ? { project_id: repository.projectId } : {}),
    reason,
    session_ids: [sessionId],
    observation_ids: [],
    candidate_ids: [],
    max_retries: maxRetries,
  });
  return { runId: run.run_id, eventId };
}

function statusOf(
  repository: FileMemoryRepository,
  scope: "project" | "global",
  runId: string,
): string | undefined {
  return listDreamRuns(repository.dreamsDir(scope))
    .find((run) => run.run_id === runId)?.status;
}

function noopPipeline(...dreams: QueuedDream[]): unknown[] {
  return dreams.flatMap((dream, index) => {
    const proposal: DreamProposal = {
      proposal_id: `noop-${index}`,
      operation: "NOOP",
      source_event_ids: [dream.eventId],
      target_ids: [],
      derives_from: [],
      reason: "No durable claim in this session",
    };
    return [
      { schema: "rubato.memory.extractor/v1", proposals: [proposal] },
      {
        schema: "rubato.memory.critic/v1",
        decisions: [{
          proposal_id: proposal.proposal_id,
          verdict: "ACCEPT",
          reason: "Nothing to learn",
        }],
      },
      {
        schema: "rubato.memory.reconciler/v1",
        proposals: [{ ...proposal, derives_from: [proposal.proposal_id] }],
      },
    ];
  });
}

class FakeModelProvider implements ModelProvider {
  readonly name = "fake-dream-runner";
  readonly calls: ChatParams[] = [];
  private readonly responses: unknown[];
  private delayFirstCallMs: number;

  constructor(responses: unknown[], delayFirstCallMs = 0) {
    this.responses = [...responses];
    this.delayFirstCallMs = delayFirstCallMs;
  }

  async *chat(params: ChatParams): AsyncIterable<StreamEvent> {
    this.calls.push(params);
    if (this.delayFirstCallMs > 0) {
      const delay = this.delayFirstCallMs;
      this.delayFirstCallMs = 0;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    if (this.responses.length === 0) {
      yield { type: "error", message: "No fake response configured", retryable: false };
      return;
    }
    const response = this.responses.shift();
    yield {
      type: "text_delta",
      text: typeof response === "string" ? response : JSON.stringify(response),
    };
  }

  supportsPromptCaching(): boolean {
    return false;
  }

  async countTokens(): Promise<number> {
    return 0;
  }
}

function makeTreeWritable(directory: string): void {
  if (!fs.existsSync(directory)) return;
  try {
    fs.chmodSync(directory, 0o700);
  } catch {
    // Best-effort cleanup of immutable release fixtures.
  }
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    try {
      if (entry.isDirectory()) makeTreeWritable(entryPath);
      else fs.chmodSync(entryPath, 0o600);
    } catch {
      // Best-effort cleanup.
    }
  }
}
