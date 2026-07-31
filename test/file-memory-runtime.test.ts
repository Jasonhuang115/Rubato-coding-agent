import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SourceEvent } from "../src/memory-files/extractor.js";
import { FileMemoryRepository } from "../src/memory-files/repository.js";
import { learnFromUserEvents } from "../src/memory-files/runtime.js";
import { readCurrentRelease } from "../src/memory-files/release.js";

describe("file memory dynamic learning runtime", () => {
  let root = "";
  let project = "";
  let previousRubatoHome: string | undefined;

  beforeEach(() => {
    previousRubatoHome = process.env.RUBATO_HOME;
    root = fs.mkdtempSync(path.join(os.tmpdir(), "rubato-memory-runtime-"));
    project = path.join(root, "project");
    fs.mkdirSync(project);
    process.env.RUBATO_HOME = root;
  });

  afterEach(() => {
    if (previousRubatoHome === undefined) delete process.env.RUBATO_HOME;
    else process.env.RUBATO_HOME = previousRubatoHome;
    makeWritable(root);
    fs.rmSync(root, { recursive: true, force: true });
  });

  function event(
    content: string,
    sessionId: string,
    id: string,
  ): SourceEvent {
    return {
      id,
      actor: "user",
      content,
      sessionId,
      observedAt: `2026-07-${sessionId === "session-1" ? "30" : "31"}T00:00:00.000Z`,
      eventSeq: 1,
      eventHash: (sessionId === "session-1" ? "a" : "b").repeat(64),
    };
  }

  it("publishes an explicit low-risk preference through an immutable release", () => {
    const result = learnFromUserEvents([
      event("我偏好用中文回答。", "session-1", "event-1"),
    ], { workingDir: project });
    expect(result).toMatchObject({
      observed: 1,
      needsReview: 0,
    });
    expect(result.publishedReleaseIds).toHaveLength(1);

    const repository = new FileMemoryRepository({ projectDir: project });
    const current = readCurrentRelease(repository.projectPaths);
    expect(current?.cards).toEqual([
      expect.objectContaining({
        logicalKey: "communication.language",
        body: "zh",
        status: "active",
        application: "automatic",
        authority: "user_explicit",
      }),
    ]);
    expect(repository.listCandidates("published")).toHaveLength(1);
  });

  it("does not persist a one-off current-session request", () => {
    const result = learnFromUserEvents([
      event("这次不要解释，直接给结论。", "session-1", "event-1"),
    ], { workingDir: project });
    expect(result.observed).toBe(0);
    expect(result.skipped).toContain("event-1:session_only");
    const repository = new FileMemoryRepository({ projectDir: project });
    expect(readCurrentRelease(repository.projectPaths)).toBeNull();
  });

  it("supersedes a prior value on a newer explicit correction", () => {
    learnFromUserEvents([
      event("我偏好简洁回答。", "session-1", "event-1"),
    ], { workingDir: project });
    const correction = learnFromUserEvents([
      event(
        "其实我喜欢详细解释，别再默认简洁。",
        "session-2",
        "event-2",
      ),
    ], { workingDir: project });
    expect(correction.publishedReleaseIds).toHaveLength(1);

    const repository = new FileMemoryRepository({ projectDir: project });
    const current = readCurrentRelease(repository.projectPaths);
    expect(current?.cards).toHaveLength(1);
    expect(current?.cards[0]).toMatchObject({
      logicalKey: "communication.explanation_depth",
      body: "detailed",
      status: "confirmed",
    });
    expect(current?.cards[0].supersedes).toHaveLength(1);
    expect(fs.readdirSync(repository.projectPaths.releasesDir).length).toBe(2);
  });

  it("keeps a failed publish in review instead of bypassing corrupt CURRENT", () => {
    const repository = new FileMemoryRepository({ projectDir: project });
    fs.mkdirSync(repository.projectPaths.scopeDir, { recursive: true });
    fs.writeFileSync(repository.projectPaths.currentPath, "missing-release\n");
    const result = learnFromUserEvents([
      event("我偏好用中文回答。", "session-1", "event-1"),
    ], { workingDir: project });
    expect(result.publishedReleaseIds).toEqual([]);
    expect(result.needsReview).toBe(1);
    expect(repository.listCandidates("review")).toHaveLength(1);
    expect(fs.readFileSync(repository.projectPaths.currentPath, "utf8").trim())
      .toBe("missing-release");
  });
});

function makeWritable(root: string): void {
  if (!fs.existsSync(root)) return;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) makeWritable(target);
    try {
      fs.chmodSync(target, entry.isDirectory() ? 0o755 : 0o644);
    } catch {
      // Best-effort cleanup for immutable release fixtures.
    }
  }
  try {
    fs.chmodSync(root, 0o755);
  } catch {
    // Best-effort cleanup.
  }
}
