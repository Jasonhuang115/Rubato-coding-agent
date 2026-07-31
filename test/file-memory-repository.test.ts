import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { UserObservation } from "../src/memory-files/observation.js";
import { FileMemoryRepository } from "../src/memory-files/repository.js";
import { createBelief, type UserModelOperation } from "../src/memory-files/user-model.js";

describe("file memory observation and candidate repository", () => {
  let root = "";
  let project = "";

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "rubato-memory-repo-"));
    project = path.join(root, "project");
    fs.mkdirSync(project);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function observation(
    repository: FileMemoryRepository,
    overrides: Partial<UserObservation> = {},
  ): UserObservation {
    return {
      id: "obs-1",
      actor: "user",
      signal: "explicit_preference",
      logicalKey: "communication.language",
      value: "zh",
      scope: { kind: "project", value: repository.projectId },
      polarity: "support",
      sessionId: "session-1",
      eventId: "event-1",
      eventSeq: 1,
      eventHash: "a".repeat(64),
      observedAt: "2026-07-31T00:00:00.000Z",
      ...overrides,
    };
  }

  it("appends immutable observations idempotently", () => {
    const repository = new FileMemoryRepository({ rootDir: root, projectDir: project });
    const item = observation(repository);
    expect(repository.appendObservation(item).written).toBe(true);
    expect(repository.appendObservation(item)).toMatchObject({
      written: false,
      reason: "duplicate",
    });
    expect(repository.listObservations("project")).toEqual([item]);
  });

  it("routes domain/global observations to global memory", () => {
    const repository = new FileMemoryRepository({ rootDir: root, projectDir: project });
    const item = observation(repository, {
      scope: { kind: "domain", value: "architecture" },
    });
    repository.appendObservation(item);
    expect(repository.listObservations("global")).toEqual([item]);
    expect(repository.listObservations("project")).toEqual([]);
  });

  it("rejects observations without verifiable session provenance", () => {
    const repository = new FileMemoryRepository({ rootDir: root, projectDir: project });
    expect(() => repository.appendObservation(observation(repository, {
      eventHash: undefined,
    }))).toThrow(/event hash/);
  });

  it("writes model operations as candidates without publishing a release", () => {
    const repository = new FileMemoryRepository({ rootDir: root, projectDir: project });
    const item = observation(repository);
    const belief = createBelief([item], {
      id: "belief-language",
      now: item.observedAt,
    });
    const operation: UserModelOperation = {
      kind: "ADD",
      logicalKey: item.logicalKey,
      scope: item.scope,
      targetIds: [],
      evidenceIds: [item.id],
      proposedBelief: belief,
      statusPatches: [],
      reason: "explicit preference",
      requiresReview: false,
    };
    const first = repository.writeCandidate(operation, "low");
    const duplicate = repository.writeCandidate(operation, "low");
    expect(duplicate.id).toBe(first.id);
    expect(repository.listCandidates("pending")).toHaveLength(1);
    expect(fs.existsSync(repository.projectPaths.currentPath)).toBe(false);
  });
});
