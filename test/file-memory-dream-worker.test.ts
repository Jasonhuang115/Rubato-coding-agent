import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  ChatParams,
  ModelProvider,
  StreamEvent,
} from "../src/shared/core-types.js";
import { SessionStore } from "../src/runtime/session/storage.js";
import { SessionManager } from "../src/runtime/session/manager.js";
import {
  queueDream,
  leaseNextDream,
} from "../src/memory-files/dream.js";
import {
  runNextDream,
  type DreamClaimProposal,
  type DreamProposal,
} from "../src/memory-files/dream-worker.js";
import { buildUserProfile } from "../src/memory-files/catalog.js";
import {
  legacyTruncatedProjectMemoryId,
  projectMemoryId,
} from "../src/memory-files/paths.js";
import { FileMemoryRepository } from "../src/memory-files/repository.js";
import { readCurrentRelease } from "../src/memory-files/release.js";
import type { MemoryCard } from "../src/memory-files/types.js";

const T0 = "2026-07-31T00:00:00.000Z";

describe("periodic LLM Dream worker", () => {
  let rootDir = "";
  let projectA = "";
  let projectB = "";
  let previousRubatoHome: string | undefined;

  beforeEach(() => {
    activeStores.clear();
    previousRubatoHome = process.env.RUBATO_HOME;
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rubato-dream-worker-"));
    projectA = path.join(rootDir, "project-a");
    projectB = path.join(rootDir, "project-b");
    fs.mkdirSync(projectA);
    fs.mkdirSync(projectB);
    process.env.RUBATO_HOME = rootDir;
  });

  afterEach(() => {
    activeStores.clear();
    if (previousRubatoHome === undefined) delete process.env.RUBATO_HOME;
    else process.env.RUBATO_HOME = previousRubatoHome;
    makeTreeWritable(rootDir);
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it("publishes a cross-project provisional habit only after the deterministic gate", async () => {
    const s1 = closedSession(projectA, "session-a1", "I tend to run focused tests first.");
    const s2 = closedSession(projectA, "session-a2", "I usually run focused tests first.");
    const s3 = closedSession(projectB, "session-b1", "I keep running focused tests first.");
    const repository = new FileMemoryRepository({
      rootDir,
      projectDir: projectA,
    });
    const run = queueDream(repository.dreamsDir("global"), {
      scope: "global",
      reason: "three closed sessions",
      session_ids: [s1.sessionId, s2.sessionId, s3.sessionId],
      observation_ids: [],
      candidate_ids: [],
      max_retries: 1,
    });
    const proposal = claimProposal({
      proposalId: "habit-tests",
      sourceEventIds: [s1.eventId, s2.eventId, s3.eventId],
      scope: { kind: "global" },
      signal: "habit",
    });
    const model = new FakeModelProvider(pipelineResponses(proposal));

    const result = await runNextDream({
      workingDir: projectA,
      rootDir,
      scope: "global",
      owner: "worker-1",
      model,
    });

    expect(result?.run).toMatchObject({
      run_id: run.run_id,
      status: "published",
      attempts: 1,
      operation_count: 1,
    });
    expect(model.calls).toHaveLength(3);
    expect(model.calls.map((call) => call.system)).toEqual([
      expect.stringContaining("Extractor"),
      expect.stringContaining("Critic"),
      expect.stringContaining("Reconciler"),
    ]);
    expect(model.calls.every((call) => call.tools.length === 0)).toBe(true);
    expect(result?.learning).toMatchObject({
      observed: 3,
      duplicates: 0,
      publishedReleaseIds: [],
    });
    expect(
      result!.learning!.candidates.map((candidate) =>
        candidate.proposed_belief?.status),
    ).toContain("provisional");
    expect(
      repository.listCandidates("review", "global"),
    ).toHaveLength(0);
    expect(repository.listCandidates("published", "global")).toHaveLength(1);
    expect(repository.listCandidates("rejected", "global")).toHaveLength(2);
    expect(result?.publication).toMatchObject({
      publishedCandidateIds: [expect.stringMatching(/^candidate_/)],
      reviewCandidateIds: [],
    });
    expect(readCurrentRelease(repository.globalPaths)?.cards).toEqual([
      expect.objectContaining({
        logicalKey: "workflow.validation_order",
        body: "run_focused_tests_first",
        status: "provisional",
        application: "advisory",
        authority: "user_inferred",
      }),
    ]);

    const runDir = path.join(repository.dreamsDir("global"), run.run_id);
    for (const file of [
      "extractor.json",
      "critic.json",
      "reconciler.json",
      "operations.json",
    ]) {
      expect(fs.existsSync(path.join(runDir, file))).toBe(true);
    }
    const operations = fs.readFileSync(
      path.join(runDir, "operations.json"),
      "utf8",
    );
    expect(operations).not.toMatch(/"operation":\s*"(?:PUBLISH|PURGE)"/);
  });

  it("does not promote a habit from only two independent sessions", async () => {
    const s1 = closedSession(projectA, "session-1", "I tend to run tests first.");
    const s2 = closedSession(projectA, "session-2", "I usually run tests first.");
    const repository = new FileMemoryRepository({
      rootDir,
      projectDir: projectA,
    });
    queueDream(repository.dreamsDir("project"), {
      scope: "project",
      project_id: repository.projectId,
      reason: "two sessions",
      session_ids: [s1.sessionId, s2.sessionId],
      observation_ids: [],
      candidate_ids: [],
    });
    const proposal = claimProposal({
      proposalId: "project-habit",
      sourceEventIds: [s1.eventId, s2.eventId],
      scope: { kind: "project", value: repository.projectId },
      signal: "habit",
    });

    const result = await runNextDream({
      workingDir: projectA,
      rootDir,
      scope: "project",
      owner: "worker",
      model: new FakeModelProvider(pipelineResponses(proposal)),
    });

    expect(result?.run.status).toBe("needs_review");
    expect(
      result!.learning!.candidates.map((candidate) =>
        candidate.proposed_belief?.status),
    ).not.toContain("provisional");
    expect(result?.publication?.publishedReleaseIds).toEqual([]);
    expect(readCurrentRelease(repository.projectPaths)).toBeNull();
  });

  it("rejects an implicit global claim backed by only one project", async () => {
    const sessions = [
      closedSession(projectA, "session-1", "I tend to run tests first."),
      closedSession(projectA, "session-2", "I usually run tests first."),
      closedSession(projectA, "session-3", "I keep running tests first."),
    ];
    const repository = new FileMemoryRepository({
      rootDir,
      projectDir: projectA,
    });
    queueDream(repository.dreamsDir("global"), {
      scope: "global",
      reason: "single-project evidence",
      session_ids: sessions.map((item) => item.sessionId),
      observation_ids: [],
      candidate_ids: [],
      max_retries: 0,
    });
    const model = new FakeModelProvider([
      extractorResponse(claimProposal({
        proposalId: "bad-global-habit",
        sourceEventIds: sessions.map((item) => item.eventId),
        scope: { kind: "global" },
        signal: "habit",
      })),
    ]);

    const result = await runNextDream({
      workingDir: projectA,
      rootDir,
      scope: "global",
      owner: "worker",
      model,
    });

    expect(result?.run).toMatchObject({
      status: "needs_review",
      review_reason: "retry_limit_exceeded",
    });
    expect(result?.error).toContain("at least two projects");
    expect(model.calls).toHaveLength(1);
    expect(repository.listObservations("global")).toEqual([]);
    expect(repository.listCandidates(undefined, "global")).toEqual([]);
  });

  it.each(["PURGE", "PUBLISH"])(
    "rejects the forbidden %s operation before it can create evidence",
    async (operation) => {
      const session = closedSession(
        projectA,
        `session-${operation.toLowerCase()}`,
        "Remember that I prefer concise answers.",
      );
      const repository = new FileMemoryRepository({
        rootDir,
        projectDir: projectA,
      });
      queueDream(repository.dreamsDir("project"), {
        scope: "project",
        project_id: repository.projectId,
        reason: "forbidden operation test",
        session_ids: [session.sessionId],
        observation_ids: [],
        candidate_ids: [],
        max_retries: 0,
      });
      const model = new FakeModelProvider([{
        schema: "rubato.memory.extractor/v1",
        proposals: [{
          ...claimProposal({
            proposalId: "forbidden",
            sourceEventIds: [session.eventId],
            scope: { kind: "project", value: repository.projectId },
            signal: "remember",
          }),
          operation,
        }],
      }]);

      const result = await runNextDream({
        workingDir: projectA,
        rootDir,
        scope: "project",
        owner: "worker",
        model,
      });

      expect(result?.run.status).toBe("needs_review");
      expect(result?.error).toContain("not allowed");
      expect(repository.listObservations("project")).toEqual([]);
      expect(repository.listCandidates(undefined, "project")).toEqual([]);
      expect(readCurrentRelease(repository.projectPaths)).toBeNull();
    },
  );

  it("requires a closed, valid session chain before calling the model", async () => {
    const open = openSession(projectA, "open-session", "I usually write tests.");
    const repository = new FileMemoryRepository({
      rootDir,
      projectDir: projectA,
    });
    queueDream(repository.dreamsDir("project"), {
      scope: "project",
      project_id: repository.projectId,
      reason: "invalid session",
      session_ids: [open.sessionId],
      observation_ids: [],
      candidate_ids: [],
      max_retries: 0,
    });
    const model = new FakeModelProvider([]);

    const result = await runNextDream({
      workingDir: projectA,
      rootDir,
      scope: "project",
      owner: "worker",
      model,
    });

    expect(result?.run.status).toBe("needs_review");
    expect(result?.error).toContain("closed, valid hash chain");
    expect(model.calls).toHaveLength(0);
  });

  it("keeps a threshold-qualified but high-risk habit in review", async () => {
    const sessions = [
      closedSession(projectA, "security-1", "I tend to enable MFA."),
      closedSession(projectA, "security-2", "I usually enable MFA."),
      closedSession(projectA, "security-3", "I keep enabling MFA."),
    ];
    const repository = new FileMemoryRepository({
      rootDir,
      projectDir: projectA,
    });
    queueDream(repository.dreamsDir("project"), {
      scope: "project",
      project_id: repository.projectId,
      reason: "high-risk publication gate",
      session_ids: sessions.map((item) => item.sessionId),
      observation_ids: [],
      candidate_ids: [],
    });
    const proposal = claimProposal({
      proposalId: "security-habit",
      sourceEventIds: sessions.map((item) => item.eventId),
      scope: { kind: "project", value: repository.projectId },
      signal: "habit",
      logicalKey: "security.authentication",
      value: "always_use_mfa",
    });

    const result = await runNextDream({
      workingDir: projectA,
      rootDir,
      scope: "project",
      owner: "worker",
      model: new FakeModelProvider(pipelineResponses(proposal)),
    });

    expect(result?.run.status).toBe("needs_review");
    expect(result?.publication?.reasons.join("\n")).toContain(
      "no low-risk active or provisional candidate",
    );
    expect(repository.listCandidates("review", "project")).toHaveLength(3);
    expect(readCurrentRelease(repository.projectPaths)).toBeNull();
  });

  it.each(["truncated", "slug"] as const)(
    "discovers %s legacy project-session directories but publishes under the full SHA project",
    async (variant) => {
      const legacyId = variant === "truncated"
        ? legacyTruncatedProjectMemoryId(projectA)
        : SessionManager.resolveLegacyProjectHash(projectA);
      const session = closedSessionInProjectStore(
        legacyId,
        `${variant}-session`,
        "I prefer to run focused tests first.",
      );
      const repository = new FileMemoryRepository({
        rootDir,
        projectDir: projectA,
      });
      queueDream(repository.dreamsDir("project"), {
        scope: "project",
        project_id: repository.projectId,
        reason: `${variant} compatibility`,
        session_ids: [session.sessionId],
        observation_ids: [],
        candidate_ids: [],
      });
      const proposal = claimProposal({
        proposalId: `${variant}-preference`,
        sourceEventIds: [session.eventId],
        scope: { kind: "project", value: repository.projectId },
        signal: "explicit_preference",
        value: "run focused tests first",
      });

      const result = await runNextDream({
        workingDir: projectA,
        rootDir,
        scope: "project",
        owner: "worker",
        model: new FakeModelProvider(pipelineResponses(proposal)),
      });

      expect(result?.run.status).toBe("published");
      expect(readCurrentRelease(repository.projectPaths)?.cards[0])
        .toMatchObject({
          status: "active",
          scope: "project",
          contexts: { projects: [repository.projectId] },
        });
    },
  );

  it("reads a closed legacy flat session without inventing project ownership", async () => {
    const session = closedFlatSession(
      "flat-session",
      "This is legacy unscoped evidence.",
    );
    const repository = new FileMemoryRepository({
      rootDir,
      projectDir: projectA,
    });
    queueDream(repository.dreamsDir("global"), {
      scope: "global",
      reason: "legacy flat session",
      session_ids: [session.sessionId],
      observation_ids: [],
      candidate_ids: [],
    });
    const noop: DreamProposal = {
      proposal_id: "flat-noop",
      operation: "NOOP",
      source_event_ids: [session.eventId],
      target_ids: [],
      derives_from: [],
      reason: "No durable claim",
    };
    const model = new FakeModelProvider(pipelineResponses(noop));

    const result = await runNextDream({
      workingDir: projectA,
      rootDir,
      scope: "global",
      owner: "worker",
      model,
    });

    expect(result?.run.status).toBe("rejected");
    expect(model.calls).toHaveLength(3);
    expect(model.calls[0].messages[0].content).not.toContain(
      '"project_id":"legacy-flat"',
    );
  });

  it("rejects a symlinked legacy flat transcript before calling the model", async () => {
    const session = closedFlatSession(
      "flat-symlink",
      "I prefer concise answers.",
    );
    const transcript = path.join(
      rootDir,
      "sessions",
      `${session.sessionId}.jsonl`,
    );
    const target = path.join(rootDir, "real-flat-session.jsonl");
    fs.renameSync(transcript, target);
    fs.symlinkSync(target, transcript);
    const repository = new FileMemoryRepository({
      rootDir,
      projectDir: projectA,
    });
    queueDream(repository.dreamsDir("global"), {
      scope: "global",
      reason: "symlink rejection",
      session_ids: [session.sessionId],
      observation_ids: [],
      candidate_ids: [],
      max_retries: 0,
    });
    const model = new FakeModelProvider([]);

    const result = await runNextDream({
      workingDir: projectA,
      rootDir,
      scope: "global",
      owner: "worker",
      model,
    });

    expect(result?.run.status).toBe("needs_review");
    expect(result?.error).toContain("symlink");
    expect(model.calls).toHaveLength(0);
  });

  it("recovers an expired lease, retries structured output, and preserves queue idempotency", async () => {
    const session = closedSession(
      projectA,
      "retry-session",
      "I prefer to test first.",
    );
    const repository = new FileMemoryRepository({
      rootDir,
      projectDir: projectA,
    });
    const input = {
      scope: "project" as const,
      project_id: repository.projectId,
      reason: "retry",
      session_ids: [session.sessionId],
      observation_ids: [],
      candidate_ids: [],
      max_retries: 2,
    };
    const queued = queueDream(repository.dreamsDir("project"), input);
    expect(queueDream(repository.dreamsDir("project"), input).run_id)
      .toBe(queued.run_id);
    leaseNextDream(
      repository.dreamsDir("project"),
      "dead-worker",
      1,
      new Date(0),
    );

    const first = await runNextDream({
      workingDir: projectA,
      rootDir,
      scope: "project",
      owner: "worker",
      now: new Date(120_000),
      model: new FakeModelProvider(["not-json"]),
    });
    expect(first?.run).toMatchObject({
      status: "queued",
      attempts: 2,
    });

    const proposal = claimProposal({
      proposalId: "retry-habit",
      sourceEventIds: [session.eventId],
      scope: { kind: "project", value: repository.projectId },
      signal: "explicit_preference",
      value: "test first",
    });
    const second = await runNextDream({
      workingDir: projectA,
      rootDir,
      scope: "project",
      owner: "worker",
      model: new FakeModelProvider(pipelineResponses(proposal)),
    });
    expect(second?.run).toMatchObject({
      status: "published",
      attempts: 3,
    });
  });

  it("keeps inference-only cards out of PROFILE after provisional promotion", () => {
    const profile = buildUserProfile([
      profileCard("inferred", "inference"),
      profileCard("habit", "habit"),
    ]);
    expect(profile).not.toContain("inferred body");
    expect(profile).toContain("habit body");
  });
});

interface SessionFixture {
  sessionId: string;
  eventId: string;
}

function closedSession(
  projectDir: string,
  sessionId: string,
  content: string,
): SessionFixture {
  const fixture = openSession(projectDir, sessionId, content);
  const store = activeStores.get(sessionId)!;
  store.close();
  activeStores.delete(sessionId);
  return fixture;
}

function closedSessionInProjectStore(
  projectStoreId: string,
  sessionId: string,
  content: string,
): SessionFixture {
  const fixture = openSessionInStore(sessionId, content, projectStoreId);
  const store = activeStores.get(sessionId)!;
  store.close();
  activeStores.delete(sessionId);
  return fixture;
}

function closedFlatSession(
  sessionId: string,
  content: string,
): SessionFixture {
  const fixture = openSessionInStore(sessionId, content);
  const store = activeStores.get(sessionId)!;
  store.close();
  activeStores.delete(sessionId);
  return fixture;
}

const activeStores = new Map<string, SessionStore>();

function openSession(
  projectDir: string,
  sessionId: string,
  content: string,
): SessionFixture {
  return openSessionInStore(
    sessionId,
    content,
    projectMemoryId(projectDir),
  );
}

function openSessionInStore(
  sessionId: string,
  content: string,
  projectStoreId?: string,
): SessionFixture {
  const store = new SessionStore(sessionId, projectStoreId);
  store.init();
  store.writeMessage({ role: "user", content });
  activeStores.set(sessionId, store);
  return {
    sessionId,
    eventId: store.getRecords()[0].event_id,
  };
}

interface ClaimOptions {
  proposalId: string;
  sourceEventIds: string[];
  scope: DreamClaimProposal["scope"];
  signal: DreamClaimProposal["signal"];
  logicalKey?: string;
  value?: string;
}

function claimProposal(options: ClaimOptions): DreamClaimProposal {
  return {
    proposal_id: options.proposalId,
    operation: "ADD",
    source_event_ids: options.sourceEventIds,
    target_ids: [],
    derives_from: [],
    reason: "Repeated user-authored behavior",
    logical_key: options.logicalKey ?? "workflow.validation_order",
    value: options.value ?? "run_focused_tests_first",
    scope: options.scope,
    signal: options.signal,
    polarity: "support",
  };
}

function extractorResponse(
  proposal: DreamProposal,
): unknown {
  return {
    schema: "rubato.memory.extractor/v1",
    proposals: [proposal],
  };
}

function pipelineResponses(
  proposal: DreamProposal,
): unknown[] {
  return [
    extractorResponse(proposal),
    {
      schema: "rubato.memory.critic/v1",
      decisions: [{
        proposal_id: proposal.proposal_id,
        verdict: "ACCEPT",
        reason: "Evidence is user-authored and consistent",
      }],
    },
    {
      schema: "rubato.memory.reconciler/v1",
      proposals: [{
        ...proposal,
        derives_from: [proposal.proposal_id],
      }],
    },
  ];
}

class FakeModelProvider implements ModelProvider {
  readonly name = "fake-dream";
  readonly calls: ChatParams[] = [];
  private readonly responses: unknown[];

  constructor(responses: unknown[]) {
    this.responses = [...responses];
  }

  async *chat(params: ChatParams): AsyncIterable<StreamEvent> {
    this.calls.push(params);
    if (this.responses.length === 0) {
      yield {
        type: "error",
        message: "No fake response configured",
        retryable: false,
      };
      return;
    }
    const response = this.responses.shift();
    yield {
      type: "text_delta",
      text: typeof response === "string"
        ? response
        : JSON.stringify(response),
    };
  }

  supportsPromptCaching(): boolean {
    return false;
  }

  async countTokens(): Promise<number> {
    return 0;
  }
}

function profileCard(id: string, signal: string): MemoryCard {
  return {
    schemaVersion: 1,
    id,
    revision: 1,
    logicalKey: `preference.${id}`,
    kind: "preference",
    scope: "global",
    status: "provisional",
    origin: "inferred",
    application: "reference",
    authority: "user_inferred",
    sensitivity: "normal",
    confidence: 0.8,
    supportScore: 3,
    oppositionScore: 0,
    halfLifeDays: 30,
    title: id,
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
    createdAt: T0,
    updatedAt: T0,
    firstSeenAt: T0,
    lastSeenAt: T0,
    evidence: [{
      sessionId: "session-1",
      eventSeq: 1,
      eventHash: "a".repeat(64),
      actor: "user",
      signal,
    }],
    supersedes: [],
    conflicts: [],
  };
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
