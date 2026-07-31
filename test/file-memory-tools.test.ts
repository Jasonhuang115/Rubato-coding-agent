import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recordMemoryFileAccess } from "../src/memory-files/access.js";
import {
  listMemoryOutcomes,
  memoryUtilityScores,
} from "../src/memory-files/outcome.js";
import { projectMemoryId } from "../src/memory-files/paths.js";
import { FileMemoryRepository } from "../src/memory-files/repository.js";
import { readCurrentRelease } from "../src/memory-files/release.js";
import { SessionStore } from "../src/runtime/session/storage.js";
import type { AgentContext, AgentConfig } from "../src/shared/core-types.js";
import { memoryFeedbackTool } from "../src/tools/memory-feedback.js";
import { memoryProposeTool } from "../src/tools/memory-propose.js";

describe("MemoryPropose controlled tool", () => {
  let root = "";
  let project = "";
  let previousRubatoHome: string | undefined;

  beforeEach(() => {
    previousRubatoHome = process.env.RUBATO_HOME;
    root = fs.mkdtempSync(path.join(os.tmpdir(), "rubato-memory-tool-"));
    project = path.join(root, "workspace");
    fs.mkdirSync(project);
    process.env.RUBATO_HOME = root;
  });

  afterEach(() => {
    if (previousRubatoHome === undefined) delete process.env.RUBATO_HOME;
    else process.env.RUBATO_HOME = previousRubatoHome;
    makeWritable(root);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("publishes a grounded explicit preference from the current user event", async () => {
    const { ctx, eventId } = openUserSession(
      "session-1",
      "我偏好用中文回答。",
    );
    const result = await memoryProposeTool.handler({
      source_event_id: eventId,
      logical_key: "communication.language",
      value: "zh",
      scope: "project",
      signal: "explicit_preference",
    }, ctx);
    expect(result.isError).not.toBe(true);
    expect(result.content).toContain("Published release");

    const repository = new FileMemoryRepository({ projectDir: project });
    expect(readCurrentRelease(repository.projectPaths)?.cards[0]).toMatchObject({
      logicalKey: "communication.language",
      body: "zh",
      status: "active",
    });
  });

  it("rejects global scope that the source event did not authorize", async () => {
    const { ctx, eventId } = openUserSession(
      "session-2",
      "我偏好用中文回答。",
    );
    const result = await memoryProposeTool.handler({
      source_event_id: eventId,
      logical_key: "communication.language",
      value: "zh",
      scope: "global",
      signal: "explicit_preference",
    }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("global scope requires");
  });

  it("downgrades a fabricated value so it cannot auto-publish", async () => {
    const { ctx, eventId } = openUserSession(
      "session-3",
      "我偏好简洁回答。",
    );
    const result = await memoryProposeTool.handler({
      source_event_id: eventId,
      logical_key: "communication.explanation_depth",
      value: "detailed",
      scope: "project",
      signal: "explicit_preference",
    }, ctx);
    expect(result.isError).not.toBe(true);
    expect(result.content).toContain("No formal release was published");
    expect(result.content).toContain("require review");

    const repository = new FileMemoryRepository({ projectDir: project });
    expect(readCurrentRelease(repository.projectPaths)).toBeNull();
    expect(repository.listCandidates("review")).toHaveLength(1);
  });

  function openUserSession(
    sessionId: string,
    content: string,
  ): { ctx: AgentContext; eventId: string } {
    const store = new SessionStore(sessionId, projectMemoryId(project));
    store.init();
    store.writeMessage({ role: "user", content });
    const eventId = store.getRecords()[0].event_id;
    return { ctx: mockContext(project, sessionId), eventId };
  }
});

describe("MemoryFeedback outcome tool", () => {
  let root = "";
  let project = "";
  let previousRubatoHome: string | undefined;

  beforeEach(() => {
    previousRubatoHome = process.env.RUBATO_HOME;
    root = fs.mkdtempSync(path.join(os.tmpdir(), "rubato-memory-feedback-"));
    project = path.join(root, "workspace");
    fs.mkdirSync(project);
    process.env.RUBATO_HOME = root;
  });

  afterEach(() => {
    if (previousRubatoHome === undefined) delete process.env.RUBATO_HOME;
    else process.env.RUBATO_HOME = previousRubatoHome;
    makeWritable(root);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("unions reported ids with the access the session actually performed", async () => {
    recordMemoryFileAccess({
      sessionId: "feedback-1",
      action: "read",
      filePath: cardPath("observed_card"),
    });

    const result = await memoryFeedbackTool.handler({
      task_tags: ["testing"],
      memory_applied: ["reported_card"],
      reward: reward(),
    }, mockContext(project, "feedback-1"));

    expect(result.isError).not.toBe(true);
    expect(result.content).toContain("Belief confidence was not modified.");
    const outcomes = listMemoryOutcomes();
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({
      task_tags: ["testing"],
      memory_read: ["observed_card"],
      memory_applied: ["reported_card"],
    });
    expect(outcomes[0]).not.toHaveProperty("confidence");
  });

  it("only lets the root agent record an outcome", async () => {
    const result = await memoryFeedbackTool.handler({
      task_tags: ["testing"],
      memory_applied: ["card"],
      reward: reward(),
    }, mockContext(project, "feedback-2", 1));

    expect(result.isError).toBe(true);
    expect(listMemoryOutcomes()).toEqual([]);
  });

  it.each([
    ["reward must be an object", { reward: "great" }],
    ["reward.safety must be a number", { reward: { ...reward(), safety: "ok" } }],
    ["expected an array of strings", { memory_applied: [3] }],
    ["at least one task tag", { task_tags: [] }],
  ] as const)("rejects malformed input with %s", async (message, overrides) => {
    const result = await memoryFeedbackTool.handler({
      task_tags: ["testing"],
      memory_applied: ["card"],
      reward: reward(),
      ...overrides,
    }, mockContext(project, "feedback-3"));

    expect(result.isError).toBe(true);
    expect(result.content).toContain(message);
    expect(listMemoryOutcomes()).toEqual([]);
  });

  it("feeds the ranking signal only after the minimum-uses gate", async () => {
    const ctx = mockContext(project, "feedback-4");
    for (let index = 0; index < 4; index++) {
      await memoryFeedbackTool.handler({
        task_tags: ["testing"],
        memory_applied: ["pref_detail"],
        reward: reward(),
      }, ctx);
    }
    expect(memoryUtilityScores().size).toBe(0);

    await memoryFeedbackTool.handler({
      task_tags: ["testing"],
      memory_applied: ["pref_detail"],
      reward: reward(),
    }, ctx);

    const scores = memoryUtilityScores();
    expect(scores.get("pref_detail")).toBeGreaterThan(0);
    // Utility is derived from outcomes alone; no release was written.
    expect(readCurrentRelease(
      new FileMemoryRepository({ projectDir: project }).projectPaths,
    )).toBeNull();
  });

  function cardPath(cardId: string): string {
    return path.join(
      root,
      "memory",
      "projects",
      "project-1",
      "releases",
      "rel-1",
      "cards",
      `${cardId}.md`,
    );
  }

  function reward(): Record<string, number> {
    return {
      task_utility: 1,
      personalization: 0.8,
      efficiency: 0.5,
      retention: 0.5,
      safety: 1,
    };
  }
});

function mockContext(
  workingDir: string,
  sessionId: string,
  depth = 0,
): AgentContext {
  const config: AgentConfig = {
    model: { provider: "test", model: "test" },
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
  };
  return {
    workingDir,
    sessionId,
    config,
    depth,
    readGuard: {
      hasRead: () => false,
      markAsRead: () => {},
      serialize: () => ({ files: {} }),
    },
    permissionManager: {
      check: () => ({ allowed: true }),
    },
  };
}

function makeWritable(root: string): void {
  if (!fs.existsSync(root)) return;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) makeWritable(target);
    try {
      fs.chmodSync(target, entry.isDirectory() ? 0o755 : 0o644);
    } catch {
      // Best-effort cleanup.
    }
  }
  try {
    fs.chmodSync(root, 0o755);
  } catch {
    // Best-effort cleanup.
  }
}
