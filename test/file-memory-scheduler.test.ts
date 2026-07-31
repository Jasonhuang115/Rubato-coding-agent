import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { projectMemoryId } from "../src/memory-files/paths.js";
import { FileMemoryRepository } from "../src/memory-files/repository.js";
import { scheduleDreams } from "../src/memory-files/scheduler.js";
import { SessionStore } from "../src/runtime/session/storage.js";

describe("durable Dream scheduler", () => {
  let root = "";
  let project = "";
  let previousHome: string | undefined;

  beforeEach(() => {
    previousHome = process.env.RUBATO_HOME;
    root = fs.mkdtempSync(path.join(os.tmpdir(), "rubato-dream-scheduler-"));
    project = path.join(root, "project");
    fs.mkdirSync(project);
    process.env.RUBATO_HOME = root;
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.RUBATO_HOME;
    else process.env.RUBATO_HOME = previousHome;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("queues after five verified closed sessions and survives restarts idempotently", () => {
    const projectId = projectMemoryId(project);
    for (let index = 0; index < 5; index++) {
      const store = new SessionStore(`session-${index}`, projectId);
      store.init();
      store.writeMessage({ role: "user", content: `message ${index}` });
      store.close();
    }

    const first = scheduleDreams({
      rootDir: root,
      workingDir: project,
      policy: {
        closed_sessions: 5,
        pending_candidates: 20,
        observation_age_hours: 24,
        max_retries: 3,
      },
    });
    expect(first.queued.map((run) => run.scope).sort()).toEqual([
      "global",
      "project",
    ]);
    expect(first.queued.every((run) => run.session_ids.length === 5)).toBe(true);

    const afterRestart = scheduleDreams({
      rootDir: root,
      workingDir: project,
      policy: {
        closed_sessions: 5,
        pending_candidates: 20,
        observation_age_hours: 24,
      },
    });
    expect(afterRestart.queued).toEqual([]);
    expect(afterRestart.metrics.every((metric) =>
      metric.newly_closed_sessions === 0)).toBe(true);
  });

  it("uses the persisted observation-age clock and ignores open sessions", () => {
    const projectId = projectMemoryId(project);
    const open = new SessionStore("open-session", projectId);
    open.init();
    open.writeMessage({ role: "user", content: "not closed" });

    const repository = new FileMemoryRepository({
      rootDir: root,
      projectDir: project,
    });
    repository.appendObservation({
      id: "old-observation",
      actor: "user",
      signal: "habit",
      logicalKey: "workflow.test_first",
      value: "run focused tests first",
      scope: { kind: "project", value: projectId },
      polarity: "support",
      sessionId: "historical-session",
      eventSeq: 1,
      eventHash: "a".repeat(64),
      observedAt: "2026-07-29T00:00:00.000Z",
    });

    const result = scheduleDreams({
      rootDir: root,
      workingDir: project,
      now: new Date("2026-07-31T00:00:00.000Z"),
      policy: {
        closed_sessions: 5,
        pending_candidates: 20,
        observation_age_hours: 24,
      },
    });
    expect(result.queued).toHaveLength(1);
    expect(result.queued[0]).toMatchObject({
      scope: "project",
      observation_ids: ["old-observation"],
      session_ids: [],
    });
  });
});
